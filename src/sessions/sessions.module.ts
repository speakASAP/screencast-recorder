import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { CommandsService } from './commands.service';
import { Command } from './entities/command.entity';
import { Session } from './entities/session.entity';
import { Track } from './entities/track.entity';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [TypeOrmModule.forFeature([Session, Track, Command]), AuthModule],
  controllers: [SessionsController],
  providers: [SessionsService, CommandsService, Logger],
  exports: [SessionsService, CommandsService],
})
export class SessionsModule {}
