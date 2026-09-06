import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Agent } from '../sessions/entities/agent.entity';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [TypeOrmModule.forFeature([Agent]), AuthModule],
  controllers: [AgentsController],
  providers: [AgentsService, Logger],
  exports: [AgentsService],
})
export class AgentsModule {}
