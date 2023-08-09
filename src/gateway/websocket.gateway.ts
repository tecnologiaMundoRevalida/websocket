import {
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
  } from '@nestjs/websockets';
import { subscribe } from 'diagnostics_channel';
  import { Server, Socket } from 'socket.io';
  
  @WebSocketGateway({cors:true})
  export class WebsocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;
    
    connectedUsers: Map<string, string> = new Map();
    connectedUsersRoom: Map<string, string> = new Map();
    
    handleConnection(client: Socket, ...args: any[]) {
      const userID = client.handshake.auth.user_id;

      if (!userID) {
        // Unauthorized connection
        client.disconnect();
      }   
      this.connectedUsers.set(userID,client.id);
    }

    @SubscribeMessage('joinRoom')
    public joinRoom(client: Socket, room: string): void {
        client.join(room);
        this.connectedUsersRoom.set(client.id,room);
        client.to(room).emit('joinedRoom',client.id);
    }

    @SubscribeMessage('trainingPrintedSend')
    public handleMessage(client: Socket, payload: any): void {
        this.server.to(payload.room).emit('trainingPrintedReceived',payload);
    }

    @SubscribeMessage('trainingStopwatch')
    public trainingStopwatch(client: Socket, payload: any): void {
        this.server.to(payload.room).emit('trainingStopwatchReceived',payload);
    }

    @SubscribeMessage('finishedTraining')
    public finishedTraining(client: Socket, payload: any): void {
        this.server.to(payload.room).emit('finishedTrainingReceived',payload);
    }

    @SubscribeMessage('private')
    public privateMessage(client: Socket, payload: any): void {
        const client_id = this.connectedUsers.get(payload.student_id);
        this.server.to(client_id).emit('privateReceived',payload);
    }

    @SubscribeMessage('leaveRoom')
    public disconnectedRoom(client: Socket, room: string): void {
      client.leave(room);
      client.to(room).emit('disconnectedRoom', room);
    }

    handleDisconnect(client: Socket) {
      const room = this.connectedUsersRoom.get(client.id);
      if (room) {
        this.connectedUsersRoom.delete(client.id);
        this.disconnectedRoom(client,room);
      }
    }

  }

  