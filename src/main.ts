import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const port = Number(process.env.PORT ?? 3391);
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((error) => {
  // Never exit 0 on a failed boot: a silently dead service looks healthy to the queue.
  console.error('screencast-recorder failed to start', error);
  process.exit(1);
});
