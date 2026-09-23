import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

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

    this.getUserOnlineRoom(client, body);
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

  @SubscribeMessage('getUserOnlineRoom')
  public getUserOnlineRoom(client: Socket, payload: any): void {
    const training = String(payload.training);
    const sockets = this.socketsByUser.get(String(payload.id));
    if (!sockets) return;

    for (const socketId of sockets) {
      if (this.roomBySocket.get(socketId) === training) {
        this.server.to(training).emit('showUserOnlineRoom', socketId);
        return;
      }
    }
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
