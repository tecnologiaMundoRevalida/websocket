import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { WebsocketGateway } from '../gateway/websocket.gateway';

@Module({
  controllers: [NotificationsController],
  providers: [WebsocketGateway],
})
export class NotificationsModule {} 