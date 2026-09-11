import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandsService } from './commands.service';
import { CommandType } from './entities/command.entity';
import { Session, SessionState, isLegalTransition } from './entities/session.entity';
import { Track, TrackKind, UploadState } from './entities/track.entity';
import { CreateSessionDto, ProgressDto, StatusDto } from './dto/session.dto';

/** Live upload-queue health as last reported by an agent, held in memory. */
export interface UploadHealth {
  queued: number;
  failures: number;
  oldestPendingMs: number | null;
}

/** Live counters the console renders while a session runs and uploads. */
export interface SessionProgress {
  segments: number;
  bytes: number;
  degraded: number;
  stalled: number;
  quiet: number;
  uploaded: number;
  total: number;
  freeDiskBytes: number | null;
  activeWindow: string | null;
  upload: UploadHealth | null;
}

/**
 * How far ahead of "now" T0 is placed once every agent is ready.
 *
 * It must exceed the worst case of: the agent's current long poll returning,
 * plus its scheduling latency. Too short and an agent reports t0_missed; too
 * long and the operator waits after pressing Start.
 */
const START_BARRIER_LEAD_SECONDS = Number(process.env.START_BARRIER_LEAD_SECONDS ?? 5);

@Injectable()
export class SessionsService {
  /**
   * Per-session readiness, held in memory.
   *
   * The barrier only matters between prepare and start -- a few seconds. If the
   * API restarts inside that window the session is abandoned and the operator
   * presses Start again, which is a better outcome than persisting a
   * half-formed barrier and resuming into an unknown agent state.
   */
  private readonly readiness = new Map<string, Map<string, StatusDto>>();

  /**
   * Live readouts held in memory rather than persisted.
   *
   * Free disk and the focused window are momentary facts that matter only
   * while a session runs. The window title especially must never reach the
   * database: it can carry a file path, a customer name, or a credential
   * pasted into a terminal.
   */
  private readonly freeDisk = new Map<string, number>();
  private readonly activeWindow = new Map<string, string>();
  private readonly uploadHealth = new Map<string, UploadHealth>();

  constructor(
    @InjectRepository(Session)
    private readonly sessions: Repository<Session>,
    @InjectRepository(Track)
    private readonly tracks: Repository<Track>,
    private readonly commands: CommandsService,
  ) {}

  async create(dto: CreateSessionDto): Promise<Session> {
    const session = await this.sessions.save(
      this.sessions.create({ title: dto.title, state: SessionState.Preparing }),
    );

    const created: Track[] = [];
    for (const spec of dto.tracks) {
      created.push(
        await this.tracks.save(
          this.tracks.create({
            sessionId: session.id,
            agentId: spec.agent_id,
            kind: spec.kind as TrackKind,
            sourceRef: spec.source_ref,
            codec: spec.codec ?? null,
            fps: spec.fps ?? null,
          }),
        ),
      );
    }

    // One prepare per participating agent, carrying only that agent's tracks.
    for (const agentId of new Set(created.map((t) => t.agentId))) {
      await this.commands.queue(agentId, CommandType.Prepare, session.id, {
        tracks: created
          .filter((t) => t.agentId === agentId)
          .map((t) => ({
            track_id: t.id,
            kind: t.kind,
            source_ref: t.sourceRef,
            codec: t.codec,
            fps: t.fps,
            segment_seconds: Number(process.env.SCREEN_SEGMENT_SECONDS ?? 60),
          })),
        min_free_gb: dto.min_free_gb ?? Number(process.env.RECORDING_MIN_FREE_GB ?? 50),
      });
    }

    this.readiness.set(session.id, new Map());
    return session;
  }

  async reportStatus(sessionId: string, dto: StatusDto): Promise<{ accepted: true }> {
    const session = await this.require(sessionId);
    const participants = await this.participants(sessionId);

    if (dto.state === 'failed') {
      // One agent failing aborts the whole session. A partial start would
      // produce tracks that cannot be aligned with each other afterwards.
      await this.transition(session, SessionState.Failed);
      session.failureReason = `${dto.agent_id}: ${dto.reason ?? 'unspecified'}`;
      await this.sessions.save(session);
      this.readiness.delete(sessionId);
      return { accepted: true };
    }

    // The agent reporting `stopped` is what completes a stop. Without this the
    // session sits in `stopping` for ever: the media is captured and the
    // manifest is in, but the operator can never reach Save or Discard, so a
    // finished recording is stranded.
    if (dto.state === 'stopped') {
      if (session.state === SessionState.Stopping) {
        await this.transition(session, SessionState.Review);
        // A stop forced by the disk floor is still a real recording worth
        // reviewing, but the reason must survive so the operator knows the
        // session ended early rather than by their own hand.
        if (dto.reason) session.failureReason = dto.reason;
        await this.sessions.save(session);
      }
      return { accepted: true };
    }

    if (dto.state !== 'ready') return { accepted: true };

    const ready = this.readiness.get(sessionId) ?? new Map<string, StatusDto>();
    ready.set(dto.agent_id, dto);
    this.readiness.set(sessionId, ready);

    // Keyed by agent id, so a duplicate report from one agent cannot satisfy
    // the barrier on behalf of another.
    const allReady = participants.every((agentId) => ready.has(agentId));
    if (!allReady) return { accepted: true };

    const t0 = new Date(Date.now() + START_BARRIER_LEAD_SECONDS * 1000);
    // Fixed here rather than at Save, and computed before startedAt is
    // assigned below: prefixFor reads session.startedAt, so if this ran after
    // the assignment it would fall through to the barrier's own t0 instead of
    // the session's real start date. Nothing in this codebase sets startedAt
    // before this point today -- create() only sets title and state -- so the
    // `??` guard on the next line is defensive rather than covering a real
    // caller. A session that starts before midnight and saves after it would
    // otherwise be verified against a prefix nothing was uploaded to.
    // Continuous upload also needs it now: the agent starts writing objects
    // during recording, before Save is ever pressed.
    session.s3Prefix = this.prefixFor(session);
    session.t0 = t0;
    session.startedAt = session.startedAt ?? t0;
    // The largest skew across agents is the editor's alignment tolerance.
    session.clockOffsetMs = Math.max(
      ...[...ready.values()].map((r) => Math.abs(r.clock?.offset_ms ?? 0)),
      0,
    );
    await this.transition(session, SessionState.Recording);
    await this.sessions.save(session);

    for (const agentId of participants) {
      await this.commands.queue(agentId, CommandType.Start, sessionId, {
        t0: t0.toISOString(),
        prefix: session.s3Prefix,
      });
    }

    this.readiness.delete(sessionId);
    return { accepted: true };
  }

  async reportProgress(sessionId: string, dto: ProgressDto): Promise<{ accepted: true }> {
    await this.require(sessionId);

    for (const update of dto.tracks) {
      const track = await this.tracks.findOne({ where: { id: update.track_id } });
      if (!track) continue;
      track.segmentCount = update.segments;
      track.bytes = String(update.bytes);
      track.degraded = update.degraded ?? track.degraded;
      // An older agent build sends no `health` at all; fall back to whatever
      // is already on the row (itself defaulted to `ok`) rather than reading
      // as stalled or undefined.
      track.health = (update.health as Track['health']) ?? track.health ?? 'ok';
      await this.tracks.save(track);
    }

    // Held in memory only, never written to the database, for the reason
    // above: a window title can carry a path, a customer name, or a credential.
    if (dto.free_disk_bytes !== undefined) this.freeDisk.set(sessionId, dto.free_disk_bytes);
    if (dto.active_window) this.activeWindow.set(sessionId, dto.active_window);
    if (dto.upload_health) {
      this.uploadHealth.set(sessionId, {
        queued: dto.upload_health.queued,
        failures: dto.upload_health.failures,
        oldestPendingMs: dto.upload_health.oldest_pending_ms ?? null,
      });
    }

    return { accepted: true };
  }

  async stop(sessionId: string): Promise<Session> {
    const session = await this.require(sessionId);
    await this.transition(session, SessionState.Stopping);
    session.endedAt = new Date();
    await this.sessions.save(session);

    for (const agentId of await this.participants(sessionId)) {
      await this.commands.queue(agentId, CommandType.Stop, sessionId, {});
    }
    return session;
  }

  /** The operator's Save. Moves to uploading; storage verification decides `stored`. */
  async save(sessionId: string): Promise<Session> {
    const session = await this.require(sessionId);
    await this.transition(session, SessionState.Uploading);

    // Already fixed at start. Recomputing here is the midnight bug, and would
    // also orphan every object uploaded during recording. The fallback covers
    // an older session recorded before this change, whose prefix was never set.
    const prefix = session.s3Prefix ?? this.prefixFor(session);
    session.s3Prefix = prefix;
    await this.sessions.save(session);

    for (const agentId of await this.participants(sessionId)) {
      await this.commands.queue(agentId, CommandType.Upload, sessionId, { prefix });
    }
    return session;
  }

  async discard(sessionId: string): Promise<Session> {
    const session = await this.require(sessionId);
    await this.transition(session, SessionState.Discarded);
    await this.sessions.save(session);

    for (const agentId of await this.participants(sessionId)) {
      // Continuous upload can already have written objects to storage before
      // the operator rejects the session, so the agent needs the prefix to
      // know what to purge. An empty payload here left Discard deleting
      // nothing: the agent's abort handler had no prefix to act on.
      await this.commands.queue(agentId, CommandType.Abort, sessionId, {
        prefix: session.s3Prefix ?? undefined,
      });
    }
    return session;
  }

  /**
   * A session with its tracks and live progress.
   *
   * The console renders segment counts, byte totals and per-track health from
   * this, so returning the bare session left every row of its table empty --
   * the recording looked stalled while it was running perfectly.
   */
  async byId(sessionId: string): Promise<Session & { tracks: Track[]; progress: SessionProgress }> {
    const session = await this.require(sessionId);
    const tracks = await this.tracks.find({ where: { sessionId } });

    return Object.assign(session, {
      tracks,
      progress: {
        segments: tracks.reduce((n, t) => n + t.segmentCount, 0),
        bytes: tracks.reduce((n, t) => n + Number(t.bytes), 0),
        degraded: tracks.filter((t) => t.degraded).length,
        stalled: tracks.filter((t) => t.health === 'stalled').length,
        quiet: tracks.filter((t) => t.health === 'quiet').length,
        uploaded: tracks.filter((t) => t.uploadState === UploadState.Verified).length,
        total: tracks.length,
        freeDiskBytes: this.freeDisk.get(sessionId) ?? null,
        activeWindow: this.activeWindow.get(sessionId) ?? null,
        upload: this.uploadHealth.get(sessionId) ?? null,
      },
    });
  }

  async list(): Promise<Session[]> {
    return this.sessions.find({ order: { createdAt: 'DESC' } });
  }

  prefixFor(session: Session): string {
    const d = session.startedAt ?? session.createdAt ?? new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `sessions/${yyyy}/${mm}/${dd}/${session.id}`;
  }

  private async require(sessionId: string): Promise<Session> {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Unknown session');
    return session;
  }

  private async participants(sessionId: string): Promise<string[]> {
    const tracks = await this.tracks.find({ where: { sessionId } });
    return [...new Set(tracks.map((t) => t.agentId))];
  }

  private async transition(session: Session, to: SessionState): Promise<void> {
    if (!isLegalTransition(session.state, to)) {
      throw new BadRequestException(`Illegal transition ${session.state} -> ${to}`);
    }
    session.state = to;
  }
}
