import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Agent } from '../sessions/entities/agent.entity';
import { Command } from '../sessions/entities/command.entity';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [TypeOrmModule.forFeature([Agent, Command]), AuthModule],
  controllers: [AgentsController],
  providers: [AgentsService, Logger],
  exports: [AgentsService],
})
export class AgentsModule {}
