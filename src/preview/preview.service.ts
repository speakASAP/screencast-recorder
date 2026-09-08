import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandsService } from '../sessions/commands.service';
import { CommandType } from '../sessions/entities/command.entity';
import { Manifest } from '../sessions/entities/manifest.entity';
import { Session, SessionState } from '../sessions/entities/session.entity';
import { StorageService } from '../storage/storage.service';
import { buildTimeline, parseSamples, Timeline } from './activity-timeline';
import {
  AudioSourceLevel,
  AudioSourceView,
  DIGITAL_SILENCE_DB,
  missingAudioProxies,
  selectAudioSource,
} from './audio-selection';
import { PreviewCompleteDto } from './dto/preview.dto';
import {
  isLegalPreviewTransition,
  PreviewArtifact,
  PreviewState,
  SessionPreview,
} from './session-preview.entity';

/**
 * How long a presigned media URL stays valid.
 *
 * Long enough to watch a four-hour proxy without the URL expiring mid-view,
 * short enough that a link copied out of the page stops working the same day.
 */
export const MEDIA_URL_EXPIRY_SECONDS = 6 * 60 * 60;

export interface PreviewStatus {
  sessionId: string;
  state: PreviewState;
  audioSources: AudioSourceView[];
  sourcePath: 'local' | 'storage' | null;
  failureReason: string | null;
  durationMs: number | null;
  /**
   * A literal, never a number.
   *
   * The keystroke and click counters were wired to nothing when these
   * sessions were recorded, so every stored session reports zeroes. Rendering
   * a zero would tell the operator the session was quiet; the honest answer
   * is that the signal was never captured.
   */
  keysAndClicks: 'not-captured';
}

interface ManifestTrack {
  kind: string;
  source_ref: string;
}

interface ManifestDocument {
  agent_id?: string;
  hostname?: string;
  tracks?: ManifestTrack[];
}

/**
 * Reads a stored session back for the operator.
 *
 * Strictly read-only over storage and strictly additive over the session: it
 * presigns, it parses, and it queues a render. It never deletes an object, a
 * row or a local file -- preview is how the operator sees what was recorded,
 * and it authorises nothing.
 */
@Injectable()
export class PreviewService {
  private readonly logger = new Logger(PreviewService.name);

  constructor(
    @InjectRepository(Session) private readonly sessions: Repository<Session>,
    @InjectRepository(SessionPreview) private readonly previews: Repository<SessionPreview>,
    @InjectRepository(Manifest) private readonly manifests: Repository<Manifest>,
    private readonly storage: StorageService,
    private readonly commands: CommandsService,
  ) {}

  async status(sessionId: string): Promise<PreviewStatus> {
    const session = await this.requireSession(sessionId);
    const preview = await this.previews.findOne({ where: { sessionId } });
    const documents = await this.manifestDocuments(sessionId);

    return {
      sessionId: session.id,
      state: preview?.state ?? PreviewState.Pending,
      audioSources: this.audioSources(documents, preview),
      sourcePath: preview?.sourcePath ?? null,
      failureReason: preview?.failureReason ?? null,
      durationMs: this.videoArtifact(preview)?.durationMs ?? null,
      keysAndClicks: 'not-captured',
    };
  }

  /**
   * The activity stream of every host, on one timeline.
   *
   * A session may span machines: one manifest per agent, each with its own
   * `<hostname>/metadata/events.jsonl`. Reading only the first would drop a
   * whole machine's activity without saying so.
   */
  async timeline(sessionId: string, bucketCount: number): Promise<Timeline> {
    const session = await this.requireSession(sessionId);
    const prefix = this.requirePrefix(session);
    const documents = await this.manifestDocuments(sessionId);

    const samples = [];
    let found = 0;
    for (const document of documents) {
      const hostname = document.hostname;
      if (!hostname) continue;
      const text = await this.storage.getObjectText(`${prefix}/${hostname}/metadata/events.jsonl`);
      // Absent is distinguishable from empty here on purpose: getObjectText
      // returns null only for a missing key and throws for anything else.
      if (text === null) continue;
      found += 1;
      samples.push(...parseSamples(text));
    }

    if (found === 0) {
      // An empty timeline reads as "nothing happened". This session's activity
      // file could not be found, which is a different statement entirely.
      throw new NotFoundException(`No activity stream stored for session ${sessionId}`);
    }

    return buildTimeline(
      samples.sort((a, b) => a.ts - b.ts),
      bucketCount,
    );
  }

  /**
   * Asks the agent to render the preview proxies.
   *
   * Takes no source argument: one render produces the video proxy plus one
   * audio proxy per source, so switching source in the console later never
   * queues a second render over the same media.
   */
  async requestRender(sessionId: string): Promise<PreviewStatus> {
    const session = await this.requireSession(sessionId);

    if (session.state !== SessionState.Stored) {
      // Rendering from a session still being written would read half a
      // recording and present the result as a preview of the whole.
      throw new BadRequestException(
        `Session ${sessionId} is ${session.state}, not stored; there is nothing complete to render`,
      );
    }

    const prefix = this.requirePrefix(session);
    const existing = await this.previews.findOne({ where: { sessionId } });

    // A ready proxy is reusable, and a render already running will report
    // back on its own. Queueing again would put two ffmpeg passes on the
    // agent -- the component that must never be destabilised.
    if (existing?.state === PreviewState.Ready || existing?.state === PreviewState.Rendering) {
      return this.status(sessionId);
    }

    const documents = await this.manifestDocuments(sessionId);
    const agentId = documents.find((d) => d.agent_id)?.agent_id;
    if (!agentId) {
      throw new NotFoundException(
        `Session ${sessionId} has no manifest naming an agent, so no host can render it`,
      );
    }

    const row =
      existing ??
      this.previews.create({ sessionId, state: PreviewState.Pending, artifacts: [] });
    row.state = PreviewState.Rendering;
    row.failureReason = null;
    const saved = await this.previews.save(row);

    await this.commands.queue(agentId, CommandType.RenderPreview, sessionId, {
      prefix,
      audioSourceRefs: this.audioTrackRefs(documents),
      previewId: saved.id,
    });

    return this.status(sessionId);
  }

  async videoUrl(sessionId: string): Promise<string> {
    const preview = await this.requireReadyPreview(sessionId);
    const artifact = this.videoArtifact(preview);
    if (!artifact) {
      throw new NotFoundException(`Session ${sessionId} has no rendered video proxy`);
    }
    return this.storage.presignGet(artifact.objectKey, MEDIA_URL_EXPIRY_SECONDS);
  }

  async audioUrl(sessionId: string, sourceRef: string): Promise<string> {
    const preview = await this.requireReadyPreview(sessionId);
    const artifact = preview.artifacts.find(
      (a) => a.kind === 'audio' && a.sourceRef === sourceRef,
    );
    if (!artifact) {
      // Never fall back to another source. Playing the operator audio from a
      // microphone they did not choose, with nothing on screen saying so, is
      // the silent substitution this design forbids.
      throw new NotFoundException(
        `Session ${sessionId} has no rendered audio proxy for source ${sourceRef}`,
      );
    }
    return this.storage.presignGet(artifact.objectKey, MEDIA_URL_EXPIRY_SECONDS);
  }

  /** Records which source the operator chose to listen to. */
  async selectSource(sessionId: string, sourceRef: string): Promise<PreviewStatus> {
    await this.requireSession(sessionId);
    const preview = await this.previews.findOne({ where: { sessionId } });
    const documents = await this.manifestDocuments(sessionId);

    if (!this.audioTrackRefs(documents).includes(sourceRef)) {
      throw new NotFoundException(`Session ${sessionId} captured no audio source ${sourceRef}`);
    }
    if (!preview) {
      throw new NotFoundException(`Session ${sessionId} has no preview to select a source on`);
    }

    preview.selectedSourceRef = sourceRef;
    await this.previews.save(preview);
    return this.status(sessionId);
  }

  /**
   * Accepts the agent's report at the end of a render.
   *
   * Completeness is VERIFIED here rather than trusted. An agent reporting
   * "ready" is not evidence that every source rendered -- the same reason
   * `ManifestService.completeUpload` does not trust `dto.verified`. A set
   * missing one source is saved as failed, naming the source, because the
   * missing one is exactly the microphone the operator would have needed and
   * silently offering the rest is the failure this design exists to prevent.
   */
  async completeRender(sessionId: string, dto: PreviewCompleteDto): Promise<void> {
    const preview = await this.previews.findOne({ where: { sessionId } });
    if (!preview) {
      // A render is only started through requestRender, which creates the
      // row. A callback with no row is a stale report, not a render to record.
      this.logger.warn(`preview-complete for session ${sessionId} with no preview row; ignored`);
      return;
    }

    const target = this.targetState(dto);
    if (!isLegalPreviewTransition(preview.state, target)) {
      // A ready proxy is reusable and never re-rendered in place, so a late
      // or duplicated callback must not overwrite it.
      this.logger.warn(
        `Ignoring preview-complete for ${sessionId}: ${preview.state} -> ${target} is not a legal transition`,
      );
      return;
    }

    if (target === PreviewState.Ready) {
      const artifacts = (dto.artifacts ?? []) as PreviewArtifact[];
      const problem = await this.incompleteness(sessionId, artifacts);
      if (problem) {
        preview.state = PreviewState.Failed;
        preview.failureReason = problem;
        preview.sourcePath = dto.source_path ?? preview.sourcePath;
        await this.previews.save(preview);
        return;
      }

      preview.state = PreviewState.Ready;
      preview.artifacts = artifacts;
      preview.sourcePath = dto.source_path ?? null;
      preview.failureReason = null;
      preview.readyAt = new Date();
      await this.previews.save(preview);
      return;
    }

    preview.state = target;
    if (target === PreviewState.Failed) {
      // Never leave the row rendering forever with no reason on it: the
      // operator's only other signal is a screen that never changes.
      preview.failureReason = [dto.reason, dto.detail].filter(Boolean).join(': ') || 'render failed';
    } else {
      // Deferred: the render stood aside for a recording and never started.
      preview.failureReason = dto.reason ?? 'deferred';
    }
    await this.previews.save(preview);
  }

  private targetState(dto: PreviewCompleteDto): PreviewState {
    if (dto.state === 'ready') return PreviewState.Ready;
    if (dto.state === 'deferred') return PreviewState.Pending;
    return PreviewState.Failed;
  }

  /** Names what is missing from a claimed-complete set, or null when it is whole. */
  private async incompleteness(
    sessionId: string,
    artifacts: PreviewArtifact[],
  ): Promise<string | null> {
    if (!artifacts.some((a) => a.kind === 'video')) {
      return 'the render reported ready with no video proxy';
    }

    const documents = await this.manifestDocuments(sessionId);
    const missing = missingAudioProxies(
      this.audioTrackRefs(documents),
      artifacts.filter((a) => a.kind === 'audio').map((a) => a.objectKey),
      // missingAudioProxies rebuilds each expected key from the prefix, and
      // the artifact keys already carry it, so the prefix is derived from one
      // of them rather than re-read from the session.
      this.prefixOf(artifacts),
    );
    return missing.length > 0
      ? `no audio proxy rendered for ${missing.join(', ')}`
      : null;
  }

  private prefixOf(artifacts: PreviewArtifact[]): string {
    const key = artifacts.find((a) => a.kind === 'video')?.objectKey ?? '';
    return key.replace(/\/preview\/[^/]*$/, '');
  }

  private async requireSession(sessionId: string): Promise<Session> {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }

  private requirePrefix(session: Session): string {
    if (!session.s3Prefix) {
      throw new NotFoundException(`Session ${session.id} has no stored objects`);
    }
    return session.s3Prefix;
  }

  private async requireReadyPreview(sessionId: string): Promise<SessionPreview> {
    await this.requireSession(sessionId);
    const preview = await this.previews.findOne({ where: { sessionId } });
    if (!preview || preview.state !== PreviewState.Ready) {
      // Never regenerate on a media request: a render takes minutes and the
      // operator would be left with a request that appears to hang.
      throw new NotFoundException(
        `Session ${sessionId} has no ready preview (state: ${preview?.state ?? 'none'})`,
      );
    }
    return preview;
  }

  private async manifestDocuments(sessionId: string): Promise<ManifestDocument[]> {
    const rows = await this.manifests.find({ where: { sessionId } });
    return rows.map((row) => row.document as ManifestDocument);
  }

  private audioTrackRefs(documents: ManifestDocument[]): string[] {
    const refs: string[] = [];
    for (const document of documents) {
      for (const track of document.tracks ?? []) {
        if (track.kind === 'audio' && !refs.includes(track.source_ref)) {
          refs.push(track.source_ref);
        }
      }
    }
    return refs;
  }

  private videoArtifact(preview: SessionPreview | null | undefined): PreviewArtifact | undefined {
    return preview?.artifacts?.find((a) => a.kind === 'video');
  }

  /**
   * Every captured source, whether or not it carried signal.
   *
   * A source that recorded silence is exactly what the operator needs to see:
   * omitting it would leave them guessing which headset was live. A source
   * with no measured level yet reports at the silence floor, which the console
   * labels rather than hides.
   */
  private audioSources(
    documents: ManifestDocument[],
    preview: SessionPreview | null | undefined,
  ): AudioSourceView[] {
    const byRef = new Map<string, PreviewArtifact>();
    for (const artifact of preview?.artifacts ?? []) {
      if (artifact.kind === 'audio' && artifact.sourceRef) {
        byRef.set(artifact.sourceRef, artifact);
      }
    }

    const levels: AudioSourceLevel[] = this.audioTrackRefs(documents).map((sourceRef) => {
      const artifact = byRef.get(sourceRef);
      return {
        sourceRef,
        meanDb: artifact?.meanDb ?? DIGITAL_SILENCE_DB,
        maxDb: artifact?.maxDb ?? DIGITAL_SILENCE_DB,
      };
    });

    return selectAudioSource(levels, preview?.selectedSourceRef ?? undefined);
  }
}
