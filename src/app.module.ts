import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { AgentsModule } from './agents/agents.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { PreviewModule } from './preview/preview.module';
import { SessionsModule } from './sessions/sessions.module';
import { StorageModule } from './storage/storage.module';
import { UiModule } from './ui/ui.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // `public/` sits beside dist/ in the image, not inside it: nest build only
    // emits compiled TypeScript, so resolving from __dirname would 404.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/api/{*splat}', '/health'],
      // Without this the static index.html answers `/` before the controller
      // does, and the public landing page would never be reached.
      serveStaticOptions: { index: false },
    }),
    DatabaseModule,
    HealthModule,
    AgentsModule,
    SessionsModule,
    StorageModule,
    PreviewModule,
    UiModule,
  ],
})
export class AppModule {}
