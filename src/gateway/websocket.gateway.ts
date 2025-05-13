import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

interface OnlineUser {
  userId: string;
  socketId: string;
  connectedAt: Date;
  lastActivity?: Date;
  room?: string;
}

@WebSocketGateway({
  cors: true,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
})
export class WebsocketGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  flo = true;
  connectedUsers: Map<string, string> = new Map();
  connectedUsersOnline: Map<string, string> = new Map();
  connectedUsersRoom: Map<string, string> = new Map();

  private onlineUsers: Map<string, OnlineUser> = new Map();
  private socketToUserId: Map<string, string> = new Map();

  handleConnection(client: Socket, ...args: any[]) {
    const userId = client.handshake.auth.user_id;

    if (!userId) {
      client.disconnect();
      return;
    }

    this.connectedUsers.set(userId, client.id);
    this.connectedUsersOnline.set(client.id, userId);

    const userInfo: OnlineUser = {
      userId,
      socketId: client.id,
      connectedAt: new Date(),
      lastActivity: new Date(),
    };

    this.onlineUsers.set(userId, userInfo);
    this.socketToUserId.set(client.id, userId);

    this.broadcastOnlineUsers();
  }

  handleDisconnect(client: Socket) {
    const room = this.connectedUsersRoom.get(client.id);
    const userId = this.socketToUserId.get(client.id);

    const client_id_online = this.connectedUsersOnline.get(client.id);
    if (client_id_online) {
      this.connectedUsersOnline.delete(client.id);
      this.connectedUsers.delete(client_id_online);
    }

    if (userId) {
      this.onlineUsers.delete(userId);
      this.socketToUserId.delete(client.id);
      this.broadcastOnlineUsers();
    }

    if (room) {
      client.to(room).emit('disconnectedRoom', room);
      this.connectedUsersRoom.delete(client.id);
    }
  }

  /* --------------------------
   *  Métodos do sistema antigo (compatibilidade)
   * -------------------------- */

  @SubscribeMessage('usersOnline')
  public usersOnline(client: Socket): void {
    const onlineUsersList = this.getOnlineUsersList();
    console.log('usersOnline', onlineUsersList);
    this.server.to(client.id).emit('usersOnlineReceived', {
      users: onlineUsersList,
      count: onlineUsersList.length,
    });
  }

  @SubscribeMessage('checkUserIsOnline')
  public checkUserIsOnline(client: Socket, body: any): void {
    const isOnline = this.onlineUsers.has(body.id);
    this.server
      .to(client.id)
      .emit('checkUserIsOnlineReceived', { isOnline, id: body.id });
  }

  @SubscribeMessage('joinRoom')
  public joinRoom(client: Socket, body: any): void {
    const { training, id } = body;
    client.join(training);

    // Sistema antigo
    const client_id = this.connectedUsers.get(id);
    this.connectedUsersRoom.set(client.id, training);
    this.server
      .to(client_id)
      .emit('joinedRoom', { client_id: client.id, training });

    // Sistema novo - atualiza a sala do usuário
    const userId = this.socketToUserId.get(client.id);
    if (userId && this.onlineUsers.has(userId)) {
      const user = this.onlineUsers.get(userId);
      user.room = training;
      user.lastActivity = new Date();
      this.onlineUsers.set(userId, user);
    }

    this.getUserOnlineRoom(client, body);
    this.broadcastOnlineUsers();
  }

  @SubscribeMessage('trainingPrintedSend')
  public handleMessage(client: Socket, payload: any): void {
    this.server.to(payload.room).emit('trainingPrintedReceived', payload);
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('trainingStopwatch')
  public trainingStopwatch(client: Socket, payload: any): void {
    this.server.to(payload.room).emit('trainingStopwatchReceived', payload);
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('finishedTraining')
  public finishedTraining(client: Socket, payload: any): void {
    this.server.to(payload.room).emit('finishedTrainingReceived', payload);
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('itemsSend')
  public handleSendItems(client: Socket, payload: any): void {
    this.server.to(payload.room).emit('itemsReceived', payload);
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('private')
  public privateMessage(client: Socket, payload: any): void {
    const client_id = this.connectedUsers.get(payload.student_id);
    this.server.to(client_id).emit('privateReceived', payload);
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('getUserOnlineRoom')
  public getUserOnlineRoom(client: Socket, payload: any): void {
    const client_id = this.connectedUsers.get(payload.id);
    const user_room = this.connectedUsersRoom.get(client_id);
    if (user_room == payload.training) {
      this.server.to(payload.training).emit('showUserOnlineRoom', client_id);
    }
    this.updateUserActivity(client.id);
  }

  /* --------------------------
   *  Métodos WebRTC
   * -------------------------- */

  @SubscribeMessage('offer')
  public offer(client: Socket, payload: any): void {
    client.to(payload.room).emit('offerReceived', payload.offer);
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('answer')
  public answer(client: Socket, payload: any): void {
    client.to(payload.room).emit('answerReceived', payload.answer);
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('iceCandidate')
  public iceCandidate(client: Socket, payload: any): void {
    client.to(payload.room).emit('iceCandidateReceived', payload.candidate);
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('toggleAudioStudent')
  public toggleAudioStudent(client: Socket, payload: any): void {
    client
      .to(payload.room)
      .emit('audioToggledStudent', { audioMuted: payload.audioMuted });
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('toggleVideoStudent')
  public toggleVideoStudent(client: Socket, payload: any): void {
    client
      .to(payload.room)
      .emit('videoToggledStudent', { videoPaused: payload.videoPaused });
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('toggleAudioInstructor')
  public toggleAudioInstructor(client: Socket, payload: any): void {
    client
      .to(payload.room)
      .emit('audioToggledInstructor', { audioMuted: payload.audioMuted });
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('toggleVideoInstructor')
  public toggleVideoInstructor(client: Socket, payload: any): void {
    client
      .to(payload.room)
      .emit('videoToggledInstructor', { videoPaused: payload.videoPaused });
    this.updateUserActivity(client.id);
  }

  /* --------------------------
   *  Métodos do novo sistema
   * -------------------------- */

  @SubscribeMessage('getOnlineUsers')
  public handleGetOnlineUsers(client: Socket) {
    client.emit('onlineUsersList', this.getOnlineUsersList());
    this.updateUserActivity(client.id);
  }

  @SubscribeMessage('requestUsersUpdate')
  public requestUsersUpdate(client: Socket) {
    this.broadcastOnlineUsers();
    this.updateUserActivity(client.id);
  }

  private broadcastOnlineUsers() {
    const onlineUsersList = this.getOnlineUsersList();
    this.server.emit('onlineUsersUpdated', {
      users: onlineUsersList,
      count: onlineUsersList.length,
      timestamp: new Date().toISOString(),
    });
  }

  private getOnlineUsersList() {
    return Array.from(this.onlineUsers.values()).map((user) => ({
      userId: user.userId,
      socketId: user.socketId,
      connectedAt: user.connectedAt,
      lastActivity: user.lastActivity,
      room: user.room,
    }));
  }

  private updateUserActivity(socketId: string) {
    const userId = this.socketToUserId.get(socketId);
    if (userId && this.onlineUsers.has(userId)) {
      const user = this.onlineUsers.get(userId);
      user.lastActivity = new Date();
      this.onlineUsers.set(userId, user);
    }
  }

  @SubscribeMessage('leaveRoom')
  public disconnectedRoom(client: Socket, room: string): void {
    this.connectedUsersRoom.delete(client.id);

    const userId = this.socketToUserId.get(client.id);
    if (userId && this.onlineUsers.has(userId)) {
      const user = this.onlineUsers.get(userId);
      user.room = undefined;
      this.onlineUsers.set(userId, user);
    }

    const client_id_online = this.connectedUsersOnline.get(client.id);
    if (client_id_online) {
      this.connectedUsersOnline.delete(client.id);
      this.connectedUsers.delete(client_id_online);
    }

    client.to(room).emit('disconnectedRoom', room);
    this.broadcastOnlineUsers();
  }
}
