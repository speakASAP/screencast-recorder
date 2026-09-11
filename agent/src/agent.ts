import { t0Missed, waitUntil } from './clock';

export interface Command {
  command_id: string;
  type: 'prepare' | 'start' | 'stop' | 'abort' | 'upload' | 'render-preview' | 'puller_control';
  session_id: string;
  payload: Record<string, any>;
}

/** One rendered preview object, as reported back to the API. */
export interface RenderedArtifact {
  kind: 'video' | 'audio' | 'peaks';
  sourceRef: string | null;
  objectKey: string;
  bytes: number;
  durationMs: number | null;
  meanDb?: number;
  maxDb?: number;
}

export interface AgentDeps {
  api: {
    post(path: string, body: unknown): Promise<unknown>;
    nextCommand(agentId: string): Promise<Command | null>;
  };
  capture: {
    start(sessionId: string, tracks: unknown[]): Promise<void>;
    /** Whether a camera is delivering frames right now, and why not if it is not. */
    probeCamera(device: string): Promise<{ hasSignal: boolean; detail: string }>;
    /** Starts or stops the phone-stream puller, and reports its state. */
    puller(action: 'start' | 'stop' | 'status'): Promise<Record<string, unknown>>;
    stop(): Promise<void>;
    isRunning(): boolean;
    states(): {
      trackId: string;
      degraded: boolean;
      segments: number;
      bytes: number;
      health?: 'ok' | 'stalled' | 'quiet';
    }[];
    currentWindow(): string | null;
    /** Uploads a stopped session under the given prefix and verifies readback. */
    upload(sessionId: string, prefix: string): Promise<{ objects: number; bytes: number; verified: boolean }>;
    /** Uploads closed segments for a running session. Never throws. */
    sweepUploads(prefix: string): Promise<void>;
    /** Queue depth and failure count for the continuous uploader. */
    uploadHealth(): { queued: number; failures: number; oldestPendingMs: number | null };
    /**
     * Deletes every object continuous upload already wrote for one session.
     * Called only from `abort` when the API supplies a prefix, i.e. only on
     * an operator's explicit Discard. Never touches local media.
     */
    purgeUploads(prefix: string): Promise<number>;
    /**
     * Renders the preview set for a stored session: a silent video proxy plus
     * one audio proxy per capture source. Read-only on session media -- it
     * writes new objects under `<prefix>/preview/` and deletes nothing.
     */
    renderPreview(
      sessionId: string,
      prefix: string,
      audioSourceRefs: string[],
    ): Promise<{ artifacts: RenderedArtifact[]; sourcePath: 'local' | 'storage' }>;
  };
  clock: {
    check(): Promise<{ synchronised: boolean; offset_ms: number; source: string }>;
  };
  disk: { freeBytes(): Promise<number> };
  reloadCredentials(): Promise<void>;
  /**
   * Durable backing for the pending-report queue, so a report queued during
   * an outage survives a process restart rather than dying with `this.pending`.
   * Optional: every existing test and caller that has no durable store keeps
   * working with in-memory-only queueing.
   */
  pendingStore?: { save(reports: PendingReport[]): Promise<void> };
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
/**
 * One line per significant event, to stdout, which systemd captures.
 *
 * Deliberately plain: this runs beside an unrepeatable recording, so it must
 * not fail, buffer, or depend on a transport that can be down. Diagnosing a
 * session stuck in `preparing` previously required querying the database,
 * because everything between "agent running" and silence went unrecorded.
 */
function log(message: string): void {
  console.log(`[agent] ${message}`);
}

export class Agent {
  /** command_ids already applied, so at-least-once delivery is safe. */
  private readonly applied = new Set<string>();
  private readonly pending: PendingReport[];
  /** Tracks supplied by `prepare`; `start` carries only t0. */
  private preparedTracks: unknown[] = [];
  private sessionId: string | null = null;
  private uploadPrefix: string | null = null;
  private reloadedForThisOutage = false;

  constructor(
    private readonly deps: AgentDeps,
    private readonly config: AgentConfig,
    // Reports a prior process queued and never delivered, read from the
    // durable store at startup. Optional so every existing call site -- and
    // every test that constructs an `Agent` directly -- keeps compiling.
    initialPending: PendingReport[] = [],
  ) {
    this.pending = [...initialPending];
  }

  /** Persists the queue after it changes. Never awaited by a caller that must
   * not stall on disk I/O; `PendingStore.save` never throws. */
  private persistPending(): void {
    void this.deps.pendingStore?.save(this.pending);
  }

  async handle(command: Command): Promise<void> {
    // A redelivered start would spawn a second ffmpeg tree writing into the
    // same directory, interleaving two recordings.
    if (this.applied.has(command.command_id)) {
      // Said out loud: a duplicate and a command that never arrived look
      // identical in a silent log, and they need opposite responses.
      log(`ignored ${command.type} ${command.command_id}: already applied`);
      return;
    }
    this.applied.add(command.command_id);

    log(`handling ${command.type} for session ${command.session_id}`);

    switch (command.type) {
      case 'prepare':
        return this.prepare(command);
      case 'start':
        return this.start(command);
      case 'stop':
        return this.stop();
      case 'abort':
        return this.abort(command);
      case 'upload':
        return this.upload(command);
      case 'render-preview':
        return this.renderPreview(command);
      case 'puller_control':
        return this.pullerControl(command);
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

    const tracks = (command.payload.tracks as { kind?: string; source_ref?: string }[]) ?? [];

    // Every selected camera must be delivering frames NOW, not merely exist.
    // A v4l2loopback node with no writer is listed by discovery and opens
    // without complaint, so without this the session records an empty webcam
    // track and the operator finds out on playback, when it cannot be redone.
    for (const track of tracks) {
      if (track.kind !== 'webcam' || !track.source_ref) continue;

      const signal = await this.deps.capture.probeCamera(track.source_ref);
      if (!signal.hasSignal) {
        await this.report(command.session_id, {
          state: 'failed',
          reason: 'camera_no_signal',
          detail: `${track.source_ref}: ${signal.detail}`,
        });
        return;
      }
    }

    this.sessionId = command.session_id;
    // The track list arrives with `prepare` and NOT with `start`, whose payload
    // is only t0. Holding it here is what lets `start` be a bare timing signal.
    this.preparedTracks = tracks as unknown[];
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
    // Sent by the API at start so segments can upload during the recording.
    this.uploadPrefix = (command.payload.prefix as string | undefined) ?? null;
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

  /**
   * Drives the camera puller from the console.
   *
   * Refused while a capture is running: the puller writes the device the
   * recording is reading, so stopping it mid-session would silently empty a
   * webcam track that cannot be re-recorded.
   */
  private async pullerControl(command: Command): Promise<void> {
    const action = (command.payload.action as 'start' | 'stop' | 'status') ?? 'status';

    if (action !== 'status' && this.deps.capture.isRunning()) {
      await this.deps.api.post('/api/agents/puller', {
        agent_id: this.config.agentId,
        error: 'refused: a capture is running',
        ...(await this.deps.capture.puller('status')),
      });
      return;
    }

    await this.deps.api.post('/api/agents/puller', {
      agent_id: this.config.agentId,
      ...(await this.deps.capture.puller(action)),
    });
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

  /**
   * The operator chose Discard.
   *
   * Local media is never touched here -- Discard has never deleted it and
   * still does not. Continuous upload, though, may already have written
   * segments to storage before the operator decided to reject the session,
   * so when the API supplies the prefix it did the uploading under, those
   * objects are purged. A purge failure is logged and swallowed rather than
   * thrown: the operator has already moved on, and there is no local-side
   * action left to take.
   */
  private async abort(command?: Command): Promise<void> {
    if (this.deps.capture.isRunning()) await this.deps.capture.stop();

    const prefix = command?.payload.prefix as string | undefined;
    if (prefix) {
      await this.deps.capture
        .purgeUploads(prefix)
        .then((count) => log(`purged ${count} uploaded objects for a discarded session`))
        .catch((error) => console.error('purge failed:', (error as Error).message));
    }

    // Cleared unconditionally, not only when a prefix was purged: if this is
    // left set, the next tick's sweep re-uploads whatever `sessions.trackDirs()`
    // still finds closed on disk, re-creating the very objects a purge above
    // may just have deleted -- an endless delete/re-upload fight against a
    // session the operator already rejected.
    this.uploadPrefix = null;
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

      if (this.uploadPrefix) {
        // Swallowed deliberately. Local media is the durable copy; a storage
        // outage must not reach ffmpeg or end the tick loop.
        await this.deps.capture
          .sweepUploads(this.uploadPrefix)
          .catch((error) => console.error('upload sweep failed:', (error as Error).message));
      }

      const upload = this.deps.capture.uploadHealth();

      await this.report(
        this.sessionId,
        {
          tracks: this.deps.capture.states().map((s) => ({
            track_id: s.trackId,
            degraded: s.degraded,
            // Without these the console's progress table stays empty and a
            // healthy recording looks stalled.
            segments: s.segments,
            bytes: s.bytes,
            health: s.health ?? 'ok',
          })),
          upload_health: {
            queued: upload.queued,
            failures: upload.failures,
            oldest_pending_ms: upload.oldestPendingMs,
          },
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

    // Status carries the state changes and the refusal reasons -- the facts
    // that explain a session sitting in `preparing` with nothing capturing.
    // Progress is a heartbeat many times a minute and would drown them.
    if (kind === 'status') {
      const reason = body.reason ? ` (${String(body.reason)})` : '';
      log(`report ${String(body.state)}${reason} for session ${sessionId}`);
    }

    try {
      await this.deps.api.post(path, payload);
      this.reloadedForThisOutage = false;
    } catch (error) {
      await this.handleApiFailure(error);
      // Queue rather than drop: the operator's view should catch up when the
      // controller returns, and progress is the only evidence a session is live.
      this.pending.push({ path, body: payload });
      this.persistPending();
    }
  }

  /**
   * Renders the preview set: a silent video proxy plus one audio proxy per
   * capture source.
   *
   * Never runs while capture is live. A recording cannot be repeated and a
   * render always can, so on contention the render defers -- and the API is
   * told, so the operator sees "waiting for the recording to finish" rather
   * than a request that vanished.
   *
   * Every audio source is rendered, not just the loudest: the owner uses
   * different headsets across sessions, so picking one would sometimes strand
   * the microphone that actually captured the commentary.
   *
   * Strictly read-only on session media. It writes only new objects under
   * `preview/` and has no delete path anywhere.
   */
  private async renderPreview(command: Command): Promise<void> {
    if (this.deps.capture.isRunning()) {
      await this.reportPreview(command.session_id, {
        state: 'deferred',
        reason: 'capture_running',
      });
      return;
    }

    const prefix = command.payload.prefix as string | undefined;
    if (!prefix) {
      // Guessing a prefix would write preview objects under the wrong session.
      await this.reportPreview(command.session_id, { state: 'failed', reason: 'no_prefix' });
      return;
    }

    try {
      const result = await this.deps.capture.renderPreview(
        command.session_id,
        prefix,
        (command.payload.audioSourceRefs as string[] | undefined) ?? [],
      );
      await this.reportPreview(command.session_id, {
        state: 'ready',
        artifacts: result.artifacts,
        source_path: result.sourcePath,
      });
    } catch (error) {
      // Inert failure: nothing was modified, so a retry is always safe. A
      // partial set is a failure and never a ready preview -- objects already
      // written stay put, because nothing here deletes, and a retry
      // overwrites them.
      await this.reportPreview(command.session_id, {
        state: 'failed',
        reason: 'render_failed',
        detail: (error as Error).message,
      });
    }
  }

  private async reportPreview(sessionId: string, body: Record<string, unknown>): Promise<void> {
    const path = `/api/sessions/${sessionId}/preview-complete`;
    const payload = { agent_id: this.config.agentId, ...body };
    try {
      await this.deps.api.post(path, payload);
    } catch (error) {
      await this.handleApiFailure(error);
      // The render already ran and its objects are in the bucket. Dropping
      // the report would leave the row rendering forever with a finished
      // proxy sitting behind it.
      this.pending.push({ path, body: payload });
      this.persistPending();
    }
  }

  private async flushPending(): Promise<void> {
    while (this.pending.length > 0) {
      const next = this.pending[0];
      try {
        await this.deps.api.post(next.path, next.body);
        this.pending.shift();
        this.persistPending();
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
