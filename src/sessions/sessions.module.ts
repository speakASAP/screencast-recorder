import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentsModule } from '../agents/agents.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { CommandsService } from './commands.service';
import { Command } from './entities/command.entity';
import { Manifest } from './entities/manifest.entity';
import { Session } from './entities/session.entity';
import { Track } from './entities/track.entity';
import { SessionsController } from './sessions.controller';
import { ManifestService } from './manifest.service';
import { SessionsService } from './sessions.service';

@Module({
  imports: [TypeOrmModule.forFeature([Session, Track, Command, Manifest]),
    AuthModule,
    AgentsModule,
    StorageModule,],
  controllers: [SessionsController],
  providers: [SessionsService, CommandsService, ManifestService, Logger],
  exports: [SessionsService, CommandsService, ManifestService],
})
export class SessionsModule {}
