import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manifest } from '../sessions/entities/manifest.entity';
import { Session } from '../sessions/entities/session.entity';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
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
  ],
  controllers: [PreviewController],
  providers: [PreviewService],
  exports: [PreviewService],
})
export class PreviewModule {}
