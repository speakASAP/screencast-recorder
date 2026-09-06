import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { ManifestDto, UploadCompleteDto } from './dto/manifest.dto';
import { Manifest } from './entities/manifest.entity';
import { Session, SessionState, isLegalTransition } from './entities/session.entity';
import { Track, UploadState } from './entities/track.entity';

@Injectable()
export class ManifestService {
  private readonly logger = new Logger(ManifestService.name);

  constructor(
    @InjectRepository(Session) private readonly sessions: Repository<Session>,
    @InjectRepository(Track) private readonly tracks: Repository<Track>,
    @InjectRepository(Manifest) private readonly manifests: Repository<Manifest>,
    private readonly storage: StorageService,
  ) {}

  async ingestManifest(sessionId: string, dto: ManifestDto): Promise<{ accepted: true }> {
    const session = await this.require(sessionId);

    await this.manifests.save(
      this.manifests.create({
        sessionId,
        agentId: dto.agent_id,
        document: dto as unknown as Record<string, unknown>,
      }),
    );

    for (const track of dto.tracks ?? []) {
      const row = await this.tracks.findOne({ where: { id: track.track_id } });
      if (!row) continue;
      row.segmentCount = track.segments?.length ?? 0;
      row.bytes = String((track.segments ?? []).reduce((sum, s) => sum + (s.bytes ?? 0), 0));
      await this.tracks.save(row);
    }

    if (dto.clock_offset_ms !== undefined) {
      session.clockOffsetMs = Math.max(session.clockOffsetMs ?? 0, Math.abs(dto.clock_offset_ms));
      await this.sessions.save(session);
    }

    return { accepted: true };
  }

  /**
   * Marks the session stored, but only after independently confirming every
   * object the manifest describes is present in S3.
   *
   * `dto.verified` is the agent's own opinion and is deliberately not trusted:
   * the agent cannot see a truncated PUT that left a zero-byte key, and a
   * buggy agent that under-reports its segments would otherwise verify clean.
   */
  async completeUpload(sessionId: string, dto: UploadCompleteDto): Promise<Session> {
    const session = await this.require(sessionId);

    const stored = await this.manifests.find({ where: { sessionId } });
    if (stored.length === 0) {
      throw new BadRequestException('No manifest received for this session');
    }

    const prefix = session.s3Prefix ?? '';
    const expected = this.expectedKeys(prefix, stored);

    const result = await this.storage.verifySession(prefix, expected);
    if (!result.verified) {
      this.logger.error(
        `Refusing to store ${sessionId}: ${result.missing.length} of ${expected.length} objects missing`,
      );
      throw new BadRequestException(
        `Storage verification failed; ${result.missing.length} objects missing`,
      );
    }

    if (!isLegalTransition(session.state, SessionState.Stored)) {
      throw new BadRequestException(`Illegal transition ${session.state} -> stored`);
    }
    session.state = SessionState.Stored;
    await this.sessions.save(session);

    for (const track of await this.tracks.find({ where: { sessionId } })) {
      track.uploadState = UploadState.Verified;
      await this.tracks.save(track);
    }

    this.logger.log(`Session ${sessionId} stored: ${expected.length} objects verified`);
    return session;
  }

  /** Every object the manifests say should exist, including the manifest itself. */
  private expectedKeys(prefix: string, manifests: Manifest[]): string[] {
    const keys = new Set<string>([`${prefix}/manifest.json`]);

    for (const manifest of manifests) {
      const doc = manifest.document as unknown as ManifestDto;
      const host = doc.hostname ?? 'agent';
      for (const track of doc.tracks ?? []) {
        const dir = `${prefix}/${host}/${track.kind}-${track.source_ref}`;
        for (const segment of track.segments ?? []) {
          keys.add(`${dir}/${segment.file}`);
        }
      }
    }

    return [...keys];
  }

  private async require(sessionId: string): Promise<Session> {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Unknown session');
    return session;
  }
}
