import {
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
  } from '@nestjs/websockets';
import { subscribe } from 'diagnostics_channel';
  import { Server, Socket } from 'socket.io';
  
  @WebSocketGateway()
  export class WebsocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;
  
    connectedUsersRoom: Map<string, string> = new Map();
  
    handleConnection(client: Socket, ...args: any[]) {
      const trainingID = client.handshake.auth.training_id;
      const userID = client.handshake.auth.user_id;

      if (!trainingID || !userID) {
        // Unauthorized connection
        client.disconnect();
      }   
      
    }

    @SubscribeMessage('joinRoom')
    public joinRoom(client: Socket, room: string): void {
        client.join(room);
        this.connectedUsersRoom.set(client.id,room);
        client.emit('joinedRoom',client.id);
    }

    @SubscribeMessage('trainingPrintedSend')
    public handleMessage(client: Socket, payload: any): void {
        this.server.to(payload.room).emit('trainingPrintedReceived',payload);
    }

    @SubscribeMessage('leaveRoom')
    public disconnectedRoom(client: Socket, room: string): void {
      client.leave(room);
      client.emit('disconnectedRoom', room);
    }

    handleDisconnect(client: Socket) {
      const room = this.connectedUsersRoom.get(client.id);
      if (room) {
        this.connectedUsersRoom.delete(client.id);
        this.disconnectedRoom(client,room);
      }
    }

  }

  