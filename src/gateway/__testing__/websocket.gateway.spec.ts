import { Test, TestingModule } from '@nestjs/testing';
import { Server, Socket } from 'socket.io';
import { INestApplication } from '@nestjs/common';
import { WebsocketGateway } from '../websocket.gateway';

describe('WebsocketGateway', () => {
  let gateway: WebsocketGateway;
  let app: INestApplication;
  let mockServer: Partial<Server>;

  const makeSocket = (id: string, userId?: string): Socket =>
    ({
      id,
      data: {},
      rooms: new Set<string>(),
      recovered: false,
      handshake: {
        auth: userId ? { user_id: userId } : {},
        headers: {},
        time: '',
        address: '',
        xdomain: false,
        secure: false,
        issued: 0,
        url: '',
        query: {},
      },
      disconnect: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
      on: jest.fn(),
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    }) as unknown as Socket;

  beforeEach(async () => {
    mockServer = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [WebsocketGateway],
    }).compile();

    gateway = module.get<WebsocketGateway>(WebsocketGateway);

    app = module.createNestApplication();
    await app.init();

    // Depois do init: o @WebSocketServer() do Nest sobrescreve `server` durante
    // a inicialização, então o mock só sobrevive se for atribuído aqui.
    gateway.server = mockServer as Server;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('handleConnection', () => {
    it('recusa conexão sem user_id', () => {
      const socket = makeSocket('socket-1');

      gateway.handleConnection(socket);

      expect(socket.disconnect).toHaveBeenCalled();
      expect(gateway.userBySocket.size).toBe(0);
      expect(gateway.socketsByUser.size).toBe(0);
    });

    it('registra o socket e entra na room do usuário', () => {
      const socket = makeSocket('socket-1', 'user-123');

      gateway.handleConnection(socket);

      expect(gateway.socketsByUser.get('user-123')).toEqual(
        new Set(['socket-1']),
      );
      expect(gateway.userBySocket.get('socket-1')).toBe('user-123');
      expect(socket.join).toHaveBeenCalledWith('user:user-123');
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('acumula as conexões do mesmo usuário em vez de sobrescrever', () => {
      gateway.handleConnection(makeSocket('socket-1', 'user-123'));
      gateway.handleConnection(makeSocket('socket-2', 'user-123'));

      expect(gateway.socketsByUser.get('user-123')).toEqual(
        new Set(['socket-1', 'socket-2']),
      );
    });

    it('restaura a sala do treinamento numa reconexão recuperada', () => {
      const socket = makeSocket('socket-1', 'user-123');
      (socket as any).recovered = true;
      (socket as any).rooms = new Set([
        'socket-1',
        'user:user-123',
        'training-42',
      ]);

      gateway.handleConnection(socket);

      expect(gateway.roomBySocket.get('socket-1')).toBe('training-42');
    });
  });

  describe('handleDisconnect', () => {
    it('limpa as referências do socket e avisa a sala', () => {
      const socket = makeSocket('socket-1', 'user-123');
      gateway.handleConnection(socket);
      gateway.roomBySocket.set('socket-1', 'room-456');

      gateway.handleDisconnect(socket);

      expect(gateway.socketsByUser.has('user-123')).toBe(false);
      expect(gateway.userBySocket.has('socket-1')).toBe(false);
      expect(gateway.roomBySocket.has('socket-1')).toBe(false);
      expect(socket.to).toHaveBeenCalledWith('room-456');
      expect(socket.emit).toHaveBeenCalledWith('disconnectedRoom', 'room-456');
    });

    it('não derruba a presença quando o usuário ainda tem outra conexão viva', () => {
      const primeiraAba = makeSocket('socket-1', 'user-123');
      const segundaAba = makeSocket('socket-2', 'user-123');
      gateway.handleConnection(primeiraAba);
      gateway.handleConnection(segundaAba);

      gateway.handleDisconnect(primeiraAba);

      expect(gateway.socketsByUser.get('user-123')).toEqual(
        new Set(['socket-2']),
      );
    });

    // Regressão: o disconnect do socket morto chega até `pingTimeout` depois
    // de o cliente já ter reconectado. Com um slot único por usuário ele
    // apagava o registro do socket NOVO e o aluno ficava online porém
    // invisível para os outros até dar F5.
    it('disconnect atrasado do socket antigo não apaga o socket novo', () => {
      const socketAntigo = makeSocket('socket-antigo', 'user-123');
      gateway.handleConnection(socketAntigo);

      const socketNovo = makeSocket('socket-novo', 'user-123');
      gateway.handleConnection(socketNovo);

      gateway.handleDisconnect(socketAntigo);

      expect(gateway.socketsByUser.get('user-123')).toEqual(
        new Set(['socket-novo']),
      );

      const outro = makeSocket('socket-outro', 'user-999');
      gateway.handleConnection(outro);
      gateway.usersOnline(outro);

      expect(mockServer.emit).toHaveBeenCalledWith('usersOnlineReceived', {
        users: { 'user-123': 'socket-novo', 'user-999': 'socket-outro' },
      });
    });

    it('isola usuários diferentes', () => {
      const s1 = makeSocket('socket-1', 'user-1');
      const s2 = makeSocket('socket-2', 'user-2');
      gateway.handleConnection(s1);
      gateway.handleConnection(s2);

      gateway.handleDisconnect(s1);

      expect(gateway.socketsByUser.has('user-1')).toBe(false);
      expect(gateway.socketsByUser.has('user-2')).toBe(true);

      gateway.handleDisconnect(s2);

      expect(gateway.socketsByUser.size).toBe(0);
      expect(gateway.userBySocket.size).toBe(0);
    });
  });

  describe('leaveRoom', () => {
    // Regressão: sair da sala não pode significar ficar offline.
    it('sai da sala mas mantém o usuário online', () => {
      const socket = makeSocket('socket-1', 'user-123');
      gateway.handleConnection(socket);
      gateway.roomBySocket.set('socket-1', 'room-456');

      gateway.disconnectedRoom(socket, 'room-456');

      expect(gateway.roomBySocket.has('socket-1')).toBe(false);
      expect(socket.leave).toHaveBeenCalledWith('room-456');
      expect(socket.to).toHaveBeenCalledWith('room-456');
      expect(socket.emit).toHaveBeenCalledWith('disconnectedRoom', 'room-456');

      // continua online
      expect(gateway.socketsByUser.get('user-123')).toEqual(
        new Set(['socket-1']),
      );
      expect(gateway.userBySocket.get('socket-1')).toBe('user-123');
    });

    it('usa a sala corrente quando emitido sem payload (logout)', () => {
      const socket = makeSocket('socket-1', 'user-123');
      gateway.handleConnection(socket);
      gateway.roomBySocket.set('socket-1', 'room-456');

      gateway.disconnectedRoom(socket);

      expect(socket.leave).toHaveBeenCalledWith('room-456');
      expect(gateway.roomBySocket.has('socket-1')).toBe(false);
    });

    it('não emite nada quando o socket não estava em sala alguma', () => {
      const socket = makeSocket('socket-1', 'user-123');
      gateway.handleConnection(socket);

      gateway.disconnectedRoom(socket);

      expect(socket.leave).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
    });
  });

  describe('checkUserIsOnline', () => {
    it('devolve um socket vivo quando o usuário está online', () => {
      gateway.handleConnection(makeSocket('socket-1', 'user-123'));
      const quemPergunta = makeSocket('socket-2', 'user-999');
      gateway.handleConnection(quemPergunta);

      gateway.checkUserIsOnline(quemPergunta, { id: 'user-123' });

      expect(mockServer.emit).toHaveBeenCalledWith('checkUserIsOnlineReceived', {
        isOnline: 'socket-1',
        id: 'user-123',
      });
    });

    it('devolve undefined quando o usuário está offline', () => {
      const quemPergunta = makeSocket('socket-2', 'user-999');
      gateway.handleConnection(quemPergunta);

      gateway.checkUserIsOnline(quemPergunta, { id: 'user-123' });

      expect(mockServer.emit).toHaveBeenCalledWith('checkUserIsOnlineReceived', {
        isOnline: undefined,
        id: 'user-123',
      });
    });
  });

  describe('joinRoom', () => {
    it('entra na sala e avisa o par pela room do usuário', () => {
      const instrutor = makeSocket('socket-1', 'user-1');
      gateway.handleConnection(instrutor);

      gateway.joinRoom(instrutor, { training: 'training-42', id: 'user-2' });

      expect(instrutor.join).toHaveBeenCalledWith('training-42');
      expect(gateway.roomBySocket.get('socket-1')).toBe('training-42');
      expect(mockServer.to).toHaveBeenCalledWith('user:user-2');
      expect(mockServer.emit).toHaveBeenCalledWith('joinedRoom', {
        client_id: 'socket-1',
        training: 'training-42',
      });
    });
  });

  describe('getUserOnlineRoom', () => {
    it('anuncia o par quando ele já está na mesma sala', () => {
      const aluno = makeSocket('socket-aluno', 'user-2');
      gateway.handleConnection(aluno);
      gateway.joinRoom(aluno, { training: 'training-42', id: 'user-1' });

      const instrutor = makeSocket('socket-instrutor', 'user-1');
      gateway.handleConnection(instrutor);

      gateway.getUserOnlineRoom(instrutor, {
        training: 'training-42',
        id: 'user-2',
      });

      expect(mockServer.emit).toHaveBeenCalledWith(
        'showUserOnlineRoom',
        'socket-aluno',
      );
    });

    it('não anuncia quando o par está online mas em outra sala', () => {
      const aluno = makeSocket('socket-aluno', 'user-2');
      gateway.handleConnection(aluno);
      gateway.joinRoom(aluno, { training: 'outra-sala', id: 'user-1' });

      const instrutor = makeSocket('socket-instrutor', 'user-1');
      gateway.handleConnection(instrutor);
      (mockServer.emit as jest.Mock).mockClear();

      gateway.getUserOnlineRoom(instrutor, {
        training: 'training-42',
        id: 'user-2',
      });

      expect(mockServer.emit).not.toHaveBeenCalledWith(
        'showUserOnlineRoom',
        expect.anything(),
      );
    });
  });

  describe('private', () => {
    it('entrega em todas as conexões do destinatário', () => {
      gateway.handleConnection(makeSocket('socket-1', 'user-123'));
      const remetente = makeSocket('socket-2', 'user-999');
      gateway.handleConnection(remetente);

      const payload = { student_id: 'user-123', message: 'oi' };
      gateway.privateMessage(remetente, payload);

      expect(mockServer.to).toHaveBeenCalledWith('user:user-123');
      expect(mockServer.emit).toHaveBeenCalledWith('privateReceived', payload);
    });
  });
});
