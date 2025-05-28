import { Controller, Post, Body } from '@nestjs/common';
import { WebsocketGateway } from '../gateway/websocket.gateway';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly websocketGateway: WebsocketGateway) {}

  @Post('send')
  async sendNotification(@Body() payload: any) {
    // Emitir evento via WebSocket    
    this.websocketGateway.handleMeetingInvitation(payload);

    return { status: 'success', message: 'Notification sent' };
  }
} 