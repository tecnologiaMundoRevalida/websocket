import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WebsocketGateway } from './gateway/websocket.gateway';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [AppController],
  providers: [AppService,WebsocketGateway],
})
export class AppModule {}
