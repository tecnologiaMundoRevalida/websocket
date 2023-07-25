import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule,{cors: {
    origin: "http://localhost:3000",
  }});
  await app.listen(6000);
}
bootstrap();
