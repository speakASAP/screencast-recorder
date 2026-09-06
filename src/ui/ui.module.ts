import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { UiController } from './ui.controller';

@Module({
  imports: [AgentsModule],
  controllers: [UiController],
})
export class UiModule {}
