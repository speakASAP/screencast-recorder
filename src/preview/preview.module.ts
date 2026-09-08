import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manifest } from '../sessions/entities/manifest.entity';
import { Session } from '../sessions/entities/session.entity';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { PreviewAgentController } from './preview-agent.controller';
import { PreviewController } from './preview.controller';
import { PreviewService } from './preview.service';
import { SessionPreview } from './session-preview.entity';

/**
 * Reading a stored session back for the operator.
 *
 * Imports SessionsModule for the command queue rather than writing its own:
 * a render is an ordinary agent command and must go through the same durable
 * queue and the same at-least-once delivery as a stop or an upload.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Session, Manifest, SessionPreview]),
    StorageModule,
    SessionsModule,
    AuthModule,
  ],
  controllers: [PreviewController, PreviewAgentController],
  // Logger is listed because AgentRoleGuard takes one as its third constructor
  // argument, and AuthModule exports the guard without exporting Logger. Nest
  // resolves that argument in the CONSUMING module's context, so every module
  // using the guard must provide it -- SessionsModule already does. Without
  // this the container fails at boot, not in any unit test, and the readiness
  // probe then leaves the previous pod serving while the new one crash-loops.
  providers: [PreviewService, Logger],
  exports: [PreviewService],
})
export class PreviewModule {}
