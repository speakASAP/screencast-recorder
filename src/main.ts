import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import * as cookieParser from 'cookie-parser';
import { SessionStore } from './auth/session.store';
import { UserAuthGuard } from './auth/user-auth.guard';
import { sessionRedirect } from './auth/session-redirect.middleware';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // The session lives in an HTTP-only cookie, so the cookie parser must run
  // before the guard that reads it.
  app.use(cookieParser());

  // Static middleware runs before guards, so an unauthenticated browser would
  // otherwise be served the console HTML and see it fail. This redirects to
  // sign-in first; it is a routing convenience, and every data route is still
  // guarded independently.
  app.use(sessionRedirect);

  // Applied globally rather than per controller: a new route is guarded by
  // default and must opt out explicitly with @Public(), so forgetting the
  // decorator closes a route rather than exposing one.
  // Resolved from the container rather than constructed here: the guard must
  // share the one SessionStore instance the auth controller writes to.
  app.useGlobalGuards(new UserAuthGuard(app.get(Reflector), app.get(SessionStore)));

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
