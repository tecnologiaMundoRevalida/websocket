import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

/** Intervalo mínimo entre respostas do `getUserOnlineRoom` para o mesmo socket. */
const ROOM_QUERY_INTERVAL_MS = 1000;

/**
 * Presença e salas de treinamento.
 *
 * Um usuário pode ter VÁRIAS conexões ao mesmo tempo (duas abas, reconexão em
 * que o socket antigo ainda não expirou no servidor). Por isso a presença é
 * `user_id -> Set<socket.id>` e não `user_id -> socket.id`: com um único slot,
 * o `disconnect` atrasado de um socket morto (que chega até `pingTimeout`
 * depois) apagava o registro do socket NOVO e o aluno ficava conectado porém
 * invisível para os outros até dar F5.
 *
 * Para falar com um usuário específico usamos a room `user:<id>`, que alcança
 * todas as conexões dele sem precisarmos escolher uma.
 */
@WebSocketGateway({
  cors: true,
  // Ping a cada 25s mantém a conexão viva sob o idle timeout do load balancer;
  // 30s de tolerância para o pong evita derrubar quem está em rede instável
  // (wi-fi de universidade/hospital, 4G) por um engasgo passageiro.
  pingInterval: 25000,
  pingTimeout: 30000,
  // O adapter em memória guarda TODO pacote emitido para uma room durante
  // `maxDisconnectionDuration`, para poder reenviá-lo numa reconexão. Com 10min
  // e os payloads do treinamento (checklist inteiro a cada mudança) o heap
  // passava de 980MB e o processo morria por OOM. 2min ainda cobrem troca de
  // rede e celular dormindo, que é o caso que a recuperação existe para salvar.
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: false,
  },
})
export class WebsocketGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketGateway.name);

  /** user_id -> todos os socket.id vivos daquele usuário */
  socketsByUser: Map<string, Set<string>> = new Map();
  /** socket.id -> user_id */
  userBySocket: Map<string, string> = new Map();
  /** socket.id -> sala de treinamento em que está */
  roomBySocket: Map<string, string> = new Map();

  /** Controle do limite de respostas do `getUserOnlineRoom`, por socket. */
  private readonly lastRoomQueryAt = new Map<string, number>();
  private readonly latestRoomQuery = new Map<string, any>();
  private readonly pendingRoomQuery = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  private userRoom(userId: string): string {
    return `user:${userId}`;
  }

  /** Snapshot no formato que o front espera: `{ [user_id]: socket_id }`. */
  private presenceSnapshot(): Record<string, string> {
    const users: Record<string, string> = {};
    for (const [userId, sockets] of this.socketsByUser) {
      for (const socketId of sockets) {
        users[userId] = socketId;
      }
    }
    return users;
  }

  /** Um socket vivo do usuário, ou `undefined` se estiver offline. */
  private anySocketOf(userId: string): string | undefined {
    const sockets = this.socketsByUser.get(userId);
    if (!sockets) return undefined;
    for (const socketId of sockets) return socketId;
    return undefined;
  }

  handleConnection(client: Socket) {
    const rawUserId = client.handshake.auth?.user_id;

    if (!rawUserId) {
      // Sem identificação não há como registrar presença nem rotear mensagens.
      this.logger.warn(`Conexão sem user_id recusada (socket=${client.id})`);
      client.disconnect();
      return;
    }

    const userId = String(rawUserId);
    client.data.userId = userId;
    client.join(this.userRoom(userId));

    let sockets = this.socketsByUser.get(userId);
    if (!sockets) {
      sockets = new Set<string>();
      this.socketsByUser.set(userId, sockets);
    }
    sockets.add(client.id);
    this.userBySocket.set(client.id, userId);

    // Numa reconexão recuperada o socket.io devolve as rooms anteriores; sem
    // isto o aluno voltaria "sem sala" e pararia de receber os eventos do
    // treinamento em andamento.
    if (client.recovered) {
      for (const room of client.rooms) {
        if (room !== client.id && room !== this.userRoom(userId)) {
          this.roomBySocket.set(client.id, room);
        }
      }
    }

    this.logger.log(
      `connect user=${userId} socket=${client.id} recovered=${!!client.recovered} conexoes=${sockets.size} online=${this.socketsByUser.size}`,
    );

    client.on('disconnect', (reason: string) => {
      this.logger.log(
        `disconnect user=${userId} socket=${client.id} reason=${reason}`,
      );
    });
  }

  @SubscribeMessage('usersOnline')
  public usersOnline(client: Socket): void {
    this.server
      .to(client.id)
      .emit('usersOnlineReceived', { users: this.presenceSnapshot() });
  }

  @SubscribeMessage('checkUserIsOnline')
  public checkUserIsOnline(client: Socket, body: any): void {
    const socketId = this.anySocketOf(String(body.id));
    this.server
      .to(client.id)
      .emit('checkUserIsOnlineReceived', { isOnline: socketId, id: body.id });
  }

  @SubscribeMessage('joinRoom')
  public joinRoom(client: Socket, body: any): void {
    const training = String(body.training);

    client.join(training);
    this.roomBySocket.set(client.id, training);

    // Avisa o par (body.id) que este socket entrou. Vai para todas as conexões
    // dele, então não depende de qual aba está aberta.
    this.server
      .to(this.userRoom(String(body.id)))
      .emit('joinedRoom', { client_id: client.id, training });

    this.logger.log(
      `joinRoom user=${client.data.userId} socket=${client.id} training=${training}`,
    );

    this.announceUserInRoom(body);
  }

  @SubscribeMessage('trainingPrintedSend')
  public handleMessage(client: Socket, payload: any): void {
    this.server.to(payload.room).emit('trainingPrintedReceived', payload);
  }

  @SubscribeMessage('trainingStopwatch')
  public trainingStopwatch(client: Socket, payload: any): void {
    this.server.to(payload.room).emit('trainingStopwatchReceived', payload);
  }

  @SubscribeMessage('finishedTraining')
  public finishedTraining(client: Socket, payload: any): void {
    this.server.to(payload.room).emit('finishedTrainingReceived', payload);
  }

  @SubscribeMessage('itemsSend')
  public handleSendItems(client: Socket, payload: any): void {
    this.server.to(payload.room).emit('itemsReceived', payload);
  }

  @SubscribeMessage('private')
  public privateMessage(client: Socket, payload: any): void {
    this.server
      .to(this.userRoom(String(payload.student_id)))
      .emit('privateReceived', payload);
  }

  /** Socket do usuário que está dentro da sala `training`, se houver. */
  private socketInRoom(userId: string, training: string): string | undefined {
    const sockets = this.socketsByUser.get(userId);
    if (!sockets) return undefined;
    for (const socketId of sockets) {
      if (this.roomBySocket.get(socketId) === training) return socketId;
    }
    return undefined;
  }

  /** Anuncia para a sala que o par já está nela (usado no joinRoom). */
  private announceUserInRoom(payload: any): void {
    const training = String(payload.training);
    const socketId = this.socketInRoom(String(payload.id), training);
    if (socketId) this.server.to(training).emit('showUserOnlineRoom', socketId);
  }

  /**
   * Pergunta "o usuário X está na sala?". Responde SÓ a quem perguntou e no
   * máximo uma vez por ROOM_QUERY_INTERVAL_MS por socket.
   *
   * Antes a resposta ia para a sala inteira via `server.to(training)`, e o
   * front do instrutor reage a todo `showUserOnlineRoom` perguntando de novo:
   * cada resposta gerava uma nova pergunta, e cada tick do polling de 5s
   * abria mais um desses laços. Com o connectionStateRecovery ligado, todo
   * broadcast fica guardado no adapter, e em minutos eram 100 mil pacotes
   * `showUserOnlineRoom` na memória (OOM do heap em 23/09/2026).
   *
   * `client.emit` não passa pelo adapter, então a resposta não é guardada. O
   * limite por socket quebra o laço mesmo com o front antigo; perguntas
   * que chegam dentro da janela são atendidas pela resposta agendada, que
   * chega antes dos 3s de timeout do `checkUserIsInRoom`.
   */
  @SubscribeMessage('getUserOnlineRoom')
  public getUserOnlineRoom(client: Socket, payload: any): void {
    this.latestRoomQuery.set(client.id, payload);
    if (this.pendingRoomQuery.has(client.id)) return;

    const reply = () => {
      this.pendingRoomQuery.delete(client.id);
      this.lastRoomQueryAt.set(client.id, Date.now());
      const latest = this.latestRoomQuery.get(client.id);
      if (!latest || !client.connected) return;
      const socketId = this.socketInRoom(
        String(latest.id),
        String(latest.training),
      );
      if (socketId) client.emit('showUserOnlineRoom', socketId);
    };

    const elapsed = Date.now() - (this.lastRoomQueryAt.get(client.id) ?? 0);
    if (elapsed >= ROOM_QUERY_INTERVAL_MS) {
      reply();
      return;
    }
    this.pendingRoomQuery.set(
      client.id,
      setTimeout(reply, ROOM_QUERY_INTERVAL_MS - elapsed),
    );
  }

  /**
   * Sair da SALA não é ficar offline. Antes este handler apagava o usuário de
   * `connectedUsers`, então quem terminava um treinamento sumia da lista de
   * online para todo mundo mesmo continuando conectado.
   *
   * O front emite `leaveRoom` sem payload no logout; nesse caso usamos a sala
   * em que o socket estava.
   */
  @SubscribeMessage('leaveRoom')
  public disconnectedRoom(client: Socket, room?: string): void {
    const target = room ?? this.roomBySocket.get(client.id);
    this.roomBySocket.delete(client.id);

    if (!target) return;

    client.leave(target);
    client.to(target).emit('disconnectedRoom', target);
  }

  handleDisconnect(client: Socket) {
    const userId = this.userBySocket.get(client.id);
    const room = this.roomBySocket.get(client.id);

    this.userBySocket.delete(client.id);
    this.roomBySocket.delete(client.id);

    clearTimeout(this.pendingRoomQuery.get(client.id));
    this.pendingRoomQuery.delete(client.id);
    this.lastRoomQueryAt.delete(client.id);
    this.latestRoomQuery.delete(client.id);

    if (userId) {
      const sockets = this.socketsByUser.get(userId);
      if (sockets) {
        // Remove SÓ este socket. O usuário continua online se ainda tiver
        // outra conexão viva (outra aba, ou o socket novo de uma reconexão).
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.socketsByUser.delete(userId);
        }
      }
    }

    if (room) {
      client.to(room).emit('disconnectedRoom', room);
    }
  }
}
