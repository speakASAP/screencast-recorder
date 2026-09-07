import { t0Missed, waitUntil } from './clock';

export interface Command {
  command_id: string;
  type: 'prepare' | 'start' | 'stop' | 'abort' | 'upload';
  session_id: string;
  payload: Record<string, any>;
}

export interface AgentDeps {
  api: {
    post(path: string, body: unknown): Promise<unknown>;
    nextCommand(agentId: string): Promise<Command | null>;
  };
  capture: {
    start(sessionId: string, tracks: unknown[]): Promise<void>;
    stop(): Promise<void>;
    isRunning(): boolean;
    states(): { trackId: string; degraded: boolean }[];
    currentWindow(): string | null;
    /** Uploads a stopped session under the given prefix and verifies readback. */
    upload(sessionId: string, prefix: string): Promise<{ objects: number; bytes: number; verified: boolean }>;
  };
  clock: {
    check(): Promise<{ synchronised: boolean; offset_ms: number; source: string }>;
  };
  disk: { freeBytes(): Promise<number> };
  reloadCredentials(): Promise<void>;
}

export interface AgentConfig {
  agentId: string;
  minFreeGb: number;
}

/** A queued report that could not be delivered while the API was unreachable. */
interface PendingReport {
  path: string;
  body: unknown;
}

/**
 * The agent's command loop.
 *
 * The controlling principle: a recording in progress is never sacrificed to an
 * API problem. Local media is the source of truth, the API is a controller, and
 * every failure path here keeps ffmpeg running.
 */
export class Agent {
  /** command_ids already applied, so at-least-once delivery is safe. */
  private readonly applied = new Set<string>();
  private readonly pending: PendingReport[] = [];
  /** Tracks supplied by `prepare`; `start` carries only t0. */
  private preparedTracks: unknown[] = [];
  private sessionId: string | null = null;
  private reloadedForThisOutage = false;

  constructor(
    private readonly deps: AgentDeps,
    private readonly config: AgentConfig,
  ) {}

  async handle(command: Command): Promise<void> {
    // A redelivered start would spawn a second ffmpeg tree writing into the
    // same directory, interleaving two recordings.
    if (this.applied.has(command.command_id)) return;
    this.applied.add(command.command_id);

    switch (command.type) {
      case 'prepare':
        return this.prepare(command);
      case 'start':
        return this.start(command);
      case 'stop':
        return this.stop();
      case 'abort':
        return this.abort();
      case 'upload':
        return this.upload(command);
      default:
        return undefined;
    }
  }

  private async prepare(command: Command): Promise<void> {
    const clock = await this.deps.clock.check();
    if (!clock.synchronised) {
      // Starting unsynchronised misaligns every track in the session, and the
      // error cannot be corrected afterwards.
      await this.report(command.session_id, {
        state: 'failed',
        reason: 'clock_unsynchronised',
        clock,
      });
      return;
    }

    const free = await this.deps.disk.freeBytes();
    if (free < this.config.minFreeGb * 1e9) {
      await this.report(command.session_id, {
        state: 'failed',
        reason: 'disk_below_threshold',
        free_disk_bytes: free,
      });
      return;
    }

    this.sessionId = command.session_id;
    // The track list arrives with `prepare` and NOT with `start`, whose payload
    // is only t0. Holding it here is what lets `start` be a bare timing signal.
    this.preparedTracks = (command.payload.tracks as unknown[]) ?? [];
    await this.report(command.session_id, { state: 'ready', clock, free_disk_bytes: free });
  }

  private async start(command: Command): Promise<void> {
    const t0 = new Date(command.payload.t0);

    if (t0Missed(t0)) {
      await this.report(command.session_id, { state: 'failed', reason: 't0_missed' });
      return;
    }

    // A start with no prepared tracks would spawn nothing and then report
    // "recording", which is the worst possible outcome: the operator watches a
    // session that is capturing nothing. Fail loudly instead.
    const tracks = (command.payload.tracks as unknown[]) ?? this.preparedTracks;
    if (tracks.length === 0) {
      await this.report(command.session_id, { state: 'failed', reason: 'no_tracks_prepared' });
      return;
    }

    this.sessionId = command.session_id;
    await waitUntil(t0);

    try {
      await this.deps.capture.start(command.session_id, tracks);
    } catch (error) {
      // Never report recording when capture did not start.
      await this.report(command.session_id, {
        state: 'failed',
        reason: 'ffmpeg_failed',
        detail: (error as Error).message,
      });
      return;
    }

    await this.report(command.session_id, { state: 'recording' });
  }

  private async stop(): Promise<void> {
    const sessionId = this.sessionId;
    await this.deps.capture.stop();
    if (sessionId) await this.report(sessionId, { state: 'stopped' });
  }

  /**
   * The operator chose Save.
   *
   * The API decides whether the session is stored, from its own readback -- this
   * only moves the bytes and reports what it saw. A failure here leaves the
   * local media untouched and the session in `uploading`, which is recoverable;
   * reporting success it did not observe would not be.
   */
  private async upload(command: Command): Promise<void> {
    const prefix = command.payload.prefix as string | undefined;
    if (!prefix) {
      await this.report(command.session_id, { state: 'failed', reason: 'no_upload_prefix' });
      return;
    }

    try {
      const result = await this.deps.capture.upload(command.session_id, prefix);
      await this.deps.api.post(`/api/sessions/${command.session_id}/upload-complete`, {
        agent_id: this.config.agentId,
        objects: result.objects,
        bytes: result.bytes,
        verified: result.verified,
      });
    } catch (error) {
      await this.report(command.session_id, {
        state: 'failed',
        reason: 'upload_failed',
        detail: (error as Error).message,
      });
    }
  }

  private async abort(): Promise<void> {
    if (this.deps.capture.isRunning()) await this.deps.capture.stop();
    this.sessionId = null;
  }

  /**
   * One iteration of the loop: check disk, report progress, flush anything the
   * last outage queued.
   */
  async tick(): Promise<void> {
    if (this.deps.capture.isRunning() && this.sessionId) {
      const free = await this.deps.disk.freeBytes();

      if (free < this.config.minFreeGb * 1e9) {
        // Stop gracefully so the segments finalise. Letting ffmpeg run into a
        // full disk corrupts the tail of an unrepeatable recording.
        await this.deps.capture.stop();
        await this.report(this.sessionId, {
          state: 'stopped',
          reason: 'disk_below_threshold',
          free_disk_bytes: free,
        });
        return;
      }

      await this.report(
        this.sessionId,
        {
          tracks: this.deps.capture.states().map((s) => ({
            track_id: s.trackId,
            degraded: s.degraded,
          })),
          free_disk_bytes: free,
          active_window: this.deps.capture.currentWindow(),
        },
        'progress',
      );
    }

    await this.flushPending();
  }

  private async report(
    sessionId: string,
    body: Record<string, unknown>,
    kind: 'status' | 'progress' = 'status',
  ): Promise<void> {
    const path = `/api/sessions/${sessionId}/${kind}`;
    const payload = { agent_id: this.config.agentId, ...body };

    try {
      await this.deps.api.post(path, payload);
      this.reloadedForThisOutage = false;
    } catch (error) {
      await this.handleApiFailure(error);
      // Queue rather than drop: the operator's view should catch up when the
      // controller returns, and progress is the only evidence a session is live.
      this.pending.push({ path, body: payload });
    }
  }

  private async flushPending(): Promise<void> {
    while (this.pending.length > 0) {
      const next = this.pending[0];
      try {
        await this.deps.api.post(next.path, next.body);
        this.pending.shift();
      } catch {
        // Still down. Keep the queue for the next tick; never let this throw
        // into the caller and interrupt capture.
        return;
      }
    }
  }

  private async handleApiFailure(error: unknown): Promise<void> {
    const status = (error as { status?: number })?.status;

    // A 401 usually means the pair token rotated under us. Re-read it once per
    // outage: retrying every tick would hammer Vault through a real outage.
    if (status === 401 && !this.reloadedForThisOutage) {
      this.reloadedForThisOutage = true;
      try {
        await this.deps.reloadCredentials();
      } catch {
        /* recording continues regardless */
      }
    }
  }

  /** Exposed for the runtime loop and for tests. */
  hasPending(): boolean {
    return this.pending.length > 0;
  }
}
