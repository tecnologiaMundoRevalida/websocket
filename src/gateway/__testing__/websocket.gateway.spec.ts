import { Test, TestingModule } from '@nestjs/testing';
import { Server, Socket } from 'socket.io';
import { INestApplication } from '@nestjs/common';
import { WebsocketGateway } from '../websocket.gateway';

describe('WebsocketGateway', () => {
  let gateway: WebsocketGateway;
  let app: INestApplication;
  let mockServer: Partial<Server>;
  let mockSocket: Partial<Socket>;

  beforeEach(async () => {
    mockServer = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    };

    mockSocket = {
      id: 'mock-socket-id',
      handshake: {
        auth: {},
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
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [WebsocketGateway],
    }).compile();

    gateway = module.get<WebsocketGateway>(WebsocketGateway);
    gateway.server = mockServer as Server;

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('handleConnection', () => {
    it('should disconnect client when no user_id is provided', () => {
      gateway.handleConnection(mockSocket as Socket);
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });

    it('should add user to connectedUsers when user_id is provided', () => {
      const userID = 'user-123';
      mockSocket.handshake.auth = { user_id: userID };

      gateway.handleConnection(mockSocket as Socket);

      expect(gateway.connectedUsers.get(userID)).toBe(mockSocket.id);
      expect(gateway.connectedUsersOnline.get(mockSocket.id)).toBe(userID);
      expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('should clean up all user references when disconnected', () => {
      const userID = 'user-123';
      const roomID = 'room-456';

      // Simulate connection
      mockSocket.handshake.auth = { user_id: userID };
      gateway.handleConnection(mockSocket as Socket);

      // Simulate joining a room
      gateway.connectedUsersRoom.set(mockSocket.id, roomID);

      // Simulate disconnection
      gateway.handleDisconnect(mockSocket as Socket);

      // Verify cleanup
      expect(gateway.connectedUsers.has(userID)).toBe(false);
      expect(gateway.connectedUsersOnline.has(mockSocket.id)).toBe(false);
      expect(gateway.connectedUsersRoom.has(mockSocket.id)).toBe(false);

      // Verify room disconnection event was emitted
      // Alterado de mockServer.to para mockSocket.to
      expect(mockSocket.to).toHaveBeenCalledWith(roomID);
      expect(mockSocket.emit).toHaveBeenCalledWith('disconnectedRoom', roomID);
    });
  });
  describe('disconnectedRoom', () => {
    it('should clean up user references and emit event when leaving room', () => {
      const userID = 'user-123';
      const roomID = 'room-456';

      // Simulate connection
      mockSocket.handshake.auth = { user_id: userID };
      gateway.handleConnection(mockSocket as Socket);

      // Simulate joining a room
      gateway.connectedUsersRoom.set(mockSocket.id, roomID);

      // Call disconnectedRoom directly
      gateway.disconnectedRoom(mockSocket as Socket, roomID);

      // Verify cleanup
      expect(gateway.connectedUsers.has(userID)).toBe(false);
      expect(gateway.connectedUsersOnline.has(mockSocket.id)).toBe(false);
      expect(gateway.connectedUsersRoom.has(mockSocket.id)).toBe(false);

      // Verify event emission
      expect(mockSocket.to).toHaveBeenCalledWith(roomID);
      expect(mockSocket.emit).toHaveBeenCalledWith('disconnectedRoom', roomID);
    });
  });

  describe('forced disconnections', () => {
    it('should handle multiple forced disconnections correctly', () => {
      const user1 = 'user-1';
      const user2 = 'user-2';
      const socket1 = {
        ...mockSocket,
        id: 'socket-1',
        handshake: { auth: { user_id: user1 } },
      };
      const socket2 = {
        ...mockSocket,
        id: 'socket-2',
        handshake: { auth: { user_id: user2 } },
      };

      // Connect both users
      gateway.handleConnection(socket1 as unknown as Socket);
      gateway.handleConnection(socket2 as unknown as Socket);

      // Verify both are connected
      expect(gateway.connectedUsers.size).toBe(2);
      expect(gateway.connectedUsersOnline.size).toBe(2);

      // Force disconnect first user
      gateway.handleDisconnect(socket1 as unknown as Socket);

      // Verify only first user was disconnected
      expect(gateway.connectedUsers.has(user1)).toBe(false);
      expect(gateway.connectedUsersOnline.has(socket1.id)).toBe(false);
      expect(gateway.connectedUsers.has(user2)).toBe(true);
      expect(gateway.connectedUsersOnline.has(socket2.id)).toBe(true);

      // Force disconnect second user
      gateway.handleDisconnect(socket2 as unknown as Socket);

      // Verify both are disconnected
      expect(gateway.connectedUsers.size).toBe(0);
      expect(gateway.connectedUsersOnline.size).toBe(0);
    });
  });
});
