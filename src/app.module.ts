import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentsModule } from './agents/agents.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    HealthModule,
    AgentsModule,
    SessionsModule,
  ],
})
export class AppModule {}
