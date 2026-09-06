import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandsService } from './commands.service';
import { CommandType } from './entities/command.entity';
import { Session, SessionState, isLegalTransition } from './entities/session.entity';
import { Track, TrackKind } from './entities/track.entity';
import { CreateSessionDto, ProgressDto, StatusDto } from './dto/session.dto';

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

    if (dto.state !== 'ready') return { accepted: true };

    const ready = this.readiness.get(sessionId) ?? new Map<string, StatusDto>();
    ready.set(dto.agent_id, dto);
    this.readiness.set(sessionId, ready);

    // Keyed by agent id, so a duplicate report from one agent cannot satisfy
    // the barrier on behalf of another.
    const allReady = participants.every((agentId) => ready.has(agentId));
    if (!allReady) return { accepted: true };

    const t0 = new Date(Date.now() + START_BARRIER_LEAD_SECONDS * 1000);
    session.t0 = t0;
    session.startedAt = t0;
    // The largest skew across agents is the editor's alignment tolerance.
    session.clockOffsetMs = Math.max(
      ...[...ready.values()].map((r) => Math.abs(r.clock?.offset_ms ?? 0)),
      0,
    );
    await this.transition(session, SessionState.Recording);
    await this.sessions.save(session);

    for (const agentId of participants) {
      await this.commands.queue(agentId, CommandType.Start, sessionId, { t0: t0.toISOString() });
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
      await this.tracks.save(track);
    }

    // dto.active_window is deliberately not persisted: it is a live readout for
    // the operator, and a window title can carry a path, a customer name, or a
    // credential pasted into a terminal.
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

    // Fix the prefix now and persist it. Deriving it again at verification time
    // would recompute the date, and a session that starts before midnight and
    // saves after it would be verified against a prefix nothing was uploaded to.
    const prefix = this.prefixFor(session);
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
      await this.commands.queue(agentId, CommandType.Abort, sessionId, {});
    }
    return session;
  }

  async byId(sessionId: string): Promise<Session> {
    return this.require(sessionId);
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
