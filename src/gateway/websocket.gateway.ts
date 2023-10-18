import {
     SubscribeMessage,
     WebSocketGateway,
     WebSocketServer,
     OnGatewayConnection,
     OnGatewayDisconnect,
} from '@nestjs/websockets';
import { subscribe } from 'diagnostics_channel';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({ cors: true })
export class WebsocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
     @WebSocketServer()
     server: Server;
     flo = true;
     connectedUsers: Map<string, string> = new Map();
     connectedUsersOnline: Map<string, string> = new Map();
     connectedUsersRoom: Map<string, string> = new Map();

     handleConnection(client: Socket, ...args: any[]) {

          const userID = client.handshake.auth.user_id;

          if (!userID) {
               // Unauthorized connection
               client.disconnect();
          }
          this.connectedUsers.set(userID, client.id);
          this.connectedUsersOnline.set(client.id, userID);
     }

     @SubscribeMessage('usersOnline')
     public usersOnline(client: Socket): void {
          this.server.to(client.id).emit('usersOnlineReceived', { users: Object.fromEntries(this.connectedUsers) });
     }

     @SubscribeMessage('joinRoom')
     public joinRoom(client: Socket, body: any): void {
          client.join(body.training);
          const client_id = this.connectedUsers.get(body.id);
          this.connectedUsersRoom.set(client.id, body.training);
          this.server.to(client_id).emit('joinedRoom', client.id);
          this.getUserOnlineRoom(client, body);
     }

     @SubscribeMessage('trainingPrintedSend')
     public handleMessage(client: Socket, payload: any): void {
          this.server.to(payload.room).emit('trainingPrintedReceived', payload);
     }
     
     @SubscribeMessage('itemsSend')
     public handleSendItems(client: Socket, payload: any): void {
          this.server.to(payload.room).emit('itemsReceived', payload);
     }

     @SubscribeMessage('trainingStopwatch')
     public trainingStopwatch(client: Socket, payload: any): void {
          this.server.to(payload.room).emit('trainingStopwatchReceived', payload);
     }

     @SubscribeMessage('finishedTraining')
     public finishedTraining(client: Socket, payload: any): void {
          this.server.to(payload.room).emit('finishedTrainingReceived', payload);
     }

     @SubscribeMessage('private')
     public privateMessage(client: Socket, payload: any): void {
          const client_id = this.connectedUsers.get(payload.student_id);
          this.server.to(client_id).emit('privateReceived', payload);
     }

     @SubscribeMessage('getUserOnlineRoom')
     public getUserOnlineRoom(client: Socket, payload: any): void {
          const client_id = this.connectedUsers.get(payload.id);
          if (client_id != null)
               this.server.to(payload.training).emit('showUserOnlineRoom', client_id);
     }

     //------------INICIO WEBRTC-----------------
     // bodyExample : {room:13,offer:24123ereasd#4$$$%45e}
     @SubscribeMessage('offer')
     public offer(client: Socket, payload: any): void {
          client.to(payload.room).emit('offerReceived', payload.offer);
     }

     // bodyExample : {room:13,answer:24123ereasd#4$$$%45e}
     @SubscribeMessage('answer')
     public answer(client: Socket, payload: any): void {
          client.to(payload.room).emit('answerReceived', payload.answer);
     }

     // bodyExample : {room:13,candidate:24123ereasd#4$$$%45e}
     @SubscribeMessage('iceCandidate')
     public iceCandidate(client: Socket, payload: any): void {
          client.to(payload.room).emit('iceCandidateReceived', payload.candidate);
     }

     @SubscribeMessage('toggleAudioStudent')
     public toggleAudioStudent(client: Socket, payload: any): void {
          client.to(payload.room).emit('audioToggledStudent', { audioMuted: payload.audioMuted });
     }

     @SubscribeMessage('toggleVideoStudent')
     public toggleVideoStudent(client: Socket, payload: any): void {
          client.to(payload.room).emit('videoToggledStudent', { videoPaused: payload.videoPaused });
     }
     @SubscribeMessage('toggleAudioInstructor')
     public toggleAudioInstructor(client: Socket, payload: any): void {
          client.to(payload.room).emit('audioToggledInstructor', { audioMuted: payload.audioMuted });
     }

     @SubscribeMessage('toggleVideoInstructor')
     public toggleVideoInstructor(client: Socket, payload: any): void {
          client.to(payload.room).emit('videoToggledInstructor', { videoPaused: payload.videoPaused });
     }

     //------------FIM WEBRTC-----------------

     @SubscribeMessage('leaveRoom')
     public disconnectedRoom(client: Socket, room: string): void {
          this.connectedUsersRoom.delete(client.id);
          const client_id_online = this.connectedUsersOnline.get(client.id);
          if (client_id_online) {
               this.connectedUsersOnline.delete(client.id);
               this.connectedUsers.delete(client_id_online);
          }
          client.to(room).emit('disconnectedRoom', room);
     }

     handleDisconnect(client: Socket) {
          const room = this.connectedUsersRoom.get(client.id);
          if (room) {
               this.disconnectedRoom(client, room);
          }
     }
}
=======
  import { Server, Socket } from 'socket.io';
  
  @WebSocketGateway({cors:true})
  export class WebsocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;
    flo = true;
    connectedUsers: Map<string, string> = new Map();
    connectedUsersOnline: Map<string, string> = new Map();
    connectedUsersRoom: Map<string, string> = new Map();
    
    handleConnection(client: Socket, ...args: any[]) {
      
      const userID = client.handshake.auth.user_id;
      
      if (!userID) {
        // Unauthorized connection
        client.disconnect();
      }   
      this.connectedUsers.set(userID,client.id);
      this.connectedUsersOnline.set(client.id,userID);
    }

    @SubscribeMessage('usersOnline')
    public usersOnline(client: Socket): void {
        this.server.to(client.id).emit('usersOnlineReceived',{users: Object.fromEntries(this.connectedUsers)});
    }

    @SubscribeMessage('joinRoom')
    public joinRoom(client: Socket, body: any): void {
        client.join(body.training);
        const client_id = this.connectedUsers.get(body.id);
        this.connectedUsersRoom.set(client.id,body.training);
        this.server.to(client_id).emit('joinedRoom',client.id);
        this.getUserOnlineRoom(client,body);
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

    @SubscribeMessage('getUserOnlineRoom')
    public getUserOnlineRoom(client: Socket, payload: any): void {
        const client_id = this.connectedUsers.get(payload.id);
        const user_room = this.connectedUsersRoom.get(client_id);
        if(user_room == payload.training)
          this.server.to(payload.training).emit('showUserOnlineRoom',client_id);
    }

    //------------INICIO WEBRTC-----------------
    // bodyExample : {room:13,offer:24123ereasd#4$$$%45e}
    @SubscribeMessage('offer')
    public offer(client: Socket, payload: any): void {
      client.to(payload.room).emit('offerReceived',payload.offer);
    }

    // bodyExample : {room:13,answer:24123ereasd#4$$$%45e}
    @SubscribeMessage('answer')
    public answer(client: Socket, payload: any): void {
      client.to(payload.room).emit('answerReceived',payload.answer);
    }

    // bodyExample : {room:13,candidate:24123ereasd#4$$$%45e}
    @SubscribeMessage('iceCandidate')
    public iceCandidate(client: Socket, payload: any): void {
        client.to(payload.room).emit('iceCandidateReceived',payload.candidate);
    }

    @SubscribeMessage('toggleAudioStudent')
    public toggleAudioStudent(client: Socket, payload: any): void {
        client.to(payload.room).emit('audioToggledStudent', { audioMuted: payload.audioMuted });
    }

    @SubscribeMessage('toggleVideoStudent')
    public toggleVideoStudent(client: Socket, payload: any): void {
        client.to(payload.room).emit('videoToggledStudent', { videoPaused: payload.videoPaused });
    }
    @SubscribeMessage('toggleAudioInstructor')
    public toggleAudioInstructor(client: Socket, payload: any): void {
        client.to(payload.room).emit('audioToggledInstructor', { audioMuted: payload.audioMuted });
    }

    @SubscribeMessage('toggleVideoInstructor')
    public toggleVideoInstructor(client: Socket, payload: any): void {
        client.to(payload.room).emit('videoToggledInstructor', { videoPaused: payload.videoPaused });
    }

    //------------FIM WEBRTC-----------------

    @SubscribeMessage('leaveRoom')
    public disconnectedRoom(client: Socket, room: string): void {
      this.connectedUsersRoom.delete(client.id);
      const client_id_online = this.connectedUsersOnline.get(client.id);
      if(client_id_online){
        this.connectedUsersOnline.delete(client.id);
        this.connectedUsers.delete(client_id_online);
      }
      client.to(room).emit('disconnectedRoom', room);
    }

    handleDisconnect(client: Socket) {
      const room = this.connectedUsersRoom.get(client.id);
        this.disconnectedRoom(client,room);
    }

  }
