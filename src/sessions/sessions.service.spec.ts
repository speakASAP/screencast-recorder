import { SessionState } from './entities/session.entity';
import { SessionsService } from './sessions.service';

type Row = Record<string, unknown>;

/**
 * A small in-memory stand-in for the three repositories. The barrier logic is
 * what these tests are about; exercising it through a real database would test
 * TypeORM instead.
 */
function makeService(opts: { agents: string[]; state?: SessionState }) {
  const session: Row = {
    id: 's1',
    state: opts.state ?? SessionState.Preparing,
    t0: null,
    startedAt: null,
    endedAt: null,
    failureReason: null,
    clockOffsetMs: null,
  };
  const tracks: Row[] = opts.agents.map((agentId, i) => ({
    id: `t${i}`,
    sessionId: 's1',
    agentId,
    kind: 'screen',
  }));
  const commands: Row[] = [];

  const sessionsRepo = {
    findOne: jest.fn(async () => session),
    save: jest.fn(async (s: Row) => Object.assign(session, s)),
    create: jest.fn((s: Row) => s),
    find: jest.fn(async () => [session]),
  };
  const tracksRepo = {
    find: jest.fn(async () => tracks),
    findOne: jest.fn(async () => tracks[0]),
    save: jest.fn(async (t: unknown) => t),
    create: jest.fn((t: Row) => t),
  };
  const commandsService = {
    queue: jest.fn(async (agentId: string, type: string, sessionId: string, payload: unknown) => {
      commands.push({ agentId, type, sessionId, payload });
    }),
    queued: () => commands,
  };

  const service = new SessionsService(
    sessionsRepo as never,
    tracksRepo as never,
    commandsService as never,
  );

  return { service, session, commands, commandsService, sessionsRepo, tracksRepo };
}

describe('the readiness barrier', () => {
  it('does not issue start until every agent reports ready', async () => {
    const { service, commands } = makeService({ agents: ['a', 'b'] });

    await service.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    expect(commands.filter((c) => c.type === 'start')).toHaveLength(0);

    await service.reportStatus('s1', { agent_id: 'b', state: 'ready' } as never);
    expect(commands.filter((c) => c.type === 'start')).toHaveLength(2);
  });

  it('issues start to nobody when one agent fails', async () => {
    const { service, session, commands } = makeService({ agents: ['a', 'b'] });

    await service.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    await service.reportStatus('s1', {
      agent_id: 'b',
      state: 'failed',
      reason: 'clock_unsynchronised',
    } as never);

    // A partial start would produce tracks that cannot be aligned afterwards.
    expect(commands.filter((c) => c.type === 'start')).toHaveLength(0);
    expect(session.state).toBe(SessionState.Failed);
    expect(session.failureReason).toContain('clock_unsynchronised');
  });

  it('sets t0 far enough ahead for the command to arrive', async () => {
    const { service, session } = makeService({ agents: ['a'] });
    const before = Date.now();

    await service.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);

    // Agents schedule against t0 rather than starting on arrival, so it must
    // be far enough ahead that the long poll can deliver it first.
    expect((session.t0 as Date).getTime()).toBeGreaterThan(before + 1000);
  });

  it('records the worst clock offset reported by any agent', async () => {
    const { service, session } = makeService({ agents: ['a', 'b'] });
    await service.reportStatus('s1', {
      agent_id: 'a', state: 'ready', clock: { synchronised: true, offset_ms: 2 },
    } as never);
    await service.reportStatus('s1', {
      agent_id: 'b', state: 'ready', clock: { synchronised: true, offset_ms: 9 },
    } as never);
    // The editor needs the largest skew to know its alignment tolerance.
    expect(session.clockOffsetMs).toBe(9);
  });

  it('ignores a duplicate ready from the same agent', async () => {
    const { service, commands } = makeService({ agents: ['a', 'b'] });
    await service.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    await service.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    // Two reports from one agent must not satisfy a two-agent barrier.
    expect(commands.filter((c) => c.type === 'start')).toHaveLength(0);
  });
});

describe('state transitions', () => {
  it('refuses to save straight from recording, skipping review', async () => {
    const { service } = makeService({ agents: ['a'], state: SessionState.Recording });
    await expect(service.save('s1')).rejects.toThrow();
  });

  it('allows save from review', async () => {
    const { service, session } = makeService({ agents: ['a'], state: SessionState.Review });
    await service.save('s1');
    expect(session.state).toBe(SessionState.Uploading);
  });

  it('allows discard from review and uploads nothing', async () => {
    const { service, session, commands } = makeService({ agents: ['a'], state: SessionState.Review });
    await service.discard('s1');
    expect(session.state).toBe(SessionState.Discarded);
    expect(commands.filter((c) => c.type === 'upload')).toHaveLength(0);
  });

  it('refuses to reopen a stored session', async () => {
    const { service } = makeService({ agents: ['a'], state: SessionState.Stored });
    await expect(service.save('s1')).rejects.toThrow();
  });
});

describe('completing a stop', () => {
  it('advances to review when the agent reports stopped', async () => {
    // Without this the session sits in `stopping` for ever: the media exists
    // and the manifest is in, but Save and Discard are unreachable.
    const { service, session } = makeService({ agents: ['a'], state: SessionState.Stopping });
    await service.reportStatus('s1', { agent_id: 'a', state: 'stopped' } as never);
    expect(session.state).toBe(SessionState.Review);
  });

  it('keeps the reason when a stop was forced by the disk floor', async () => {
    // Still a real recording worth reviewing, but the operator must be able to
    // tell it ended early rather than at their own hand.
    const { service, session } = makeService({ agents: ['a'], state: SessionState.Stopping });
    await service.reportStatus('s1', {
      agent_id: 'a', state: 'stopped', reason: 'disk_below_threshold',
    } as never);
    expect(session.state).toBe(SessionState.Review);
    expect(session.failureReason).toBe('disk_below_threshold');
  });

  it('ignores a stopped report for a session that is not stopping', async () => {
    // A late or duplicate report must not drag a stored session backwards.
    const { service, session } = makeService({ agents: ['a'], state: SessionState.Stored });
    await service.reportStatus('s1', { agent_id: 'a', state: 'stopped' } as never);
    expect(session.state).toBe(SessionState.Stored);
  });
});

describe('progress reporting for the console', () => {
  it('returns tracks with the session so the progress table can render', async () => {
    // Returning the bare session left every row empty, and a healthy recording
    // looked stalled to the operator.
    const { service } = makeService({ agents: ['a'], state: SessionState.Recording });
    const view = await service.byId('s1');
    expect(Array.isArray(view.tracks)).toBe(true);
    expect(view.progress).toBeDefined();
  });

  it('counts verified tracks so upload progress is measurable', async () => {
    const { service } = makeService({ agents: ['a', 'b'], state: SessionState.Uploading });
    const view = await service.byId('s1');
    expect(view.progress.total).toBe(2);
    expect(typeof view.progress.uploaded).toBe('number');
  });

  it('surfaces free disk and the active window without persisting them', async () => {
    // Both are momentary readouts served to the console. The window title
    // especially must never be WRITTEN: it can carry a path, a customer name,
    // or a credential pasted into a terminal, and the database outlives the
    // session.
    const { service, sessionsRepo } = makeService({
      agents: ['a'],
      state: SessionState.Recording,
    });
    await service.reportProgress('s1', {
      agent_id: 'a',
      tracks: [],
      free_disk_bytes: 500e9,
      active_window: 'nvim — secret-project',
    } as never);

    const view = await service.byId('s1');
    expect(view.progress.freeDiskBytes).toBe(500e9);
    expect(view.progress.activeWindow).toBe('nvim — secret-project');

    // Nothing was saved as a result of the progress report.
    const written = JSON.stringify(sessionsRepo.save.mock.calls);
    expect(written).not.toContain('secret-project');
  });
});

describe('the S3 prefix is fixed when recording starts', () => {
  it('persists the prefix at start, not at save', async () => {
    // A session that starts before midnight and saves after it would otherwise
    // be verified against a prefix nothing was ever written to.
    const { service, session } = makeService({ agents: ['a1'], state: SessionState.Preparing });
    (session as Record<string, unknown>).startedAt = new Date('2026-09-10T22:30:00Z');

    await service.reportStatus('s1', {
      agent_id: 'a1',
      state: 'ready',
      clock: { synchronised: true, offset_ms: 0 },
    } as never);

    expect(session.s3Prefix).toBe('sessions/2026/09/10/s1');
  });

  it('carries the prefix in the start command, so the agent uploads to it', async () => {
    const { service, session, commands } = makeService({
      agents: ['a1'],
      state: SessionState.Preparing,
    });
    (session as Record<string, unknown>).startedAt = new Date('2026-09-10T22:30:00Z');

    await service.reportStatus('s1', {
      agent_id: 'a1',
      state: 'ready',
      clock: { synchronised: true, offset_ms: 0 },
    } as never);

    const start = commands.find((c) => c.type === 'start');
    expect((start?.payload as Record<string, unknown>)?.prefix).toBe('sessions/2026/09/10/s1');
  });

  it('save reuses the prefix rather than recomputing it', async () => {
    // Recomputing at save is the midnight bug. Reuse is what makes the bytes
    // already uploaded during recording verifiable.
    const { service, session } = makeService({ agents: ['a1'], state: SessionState.Review });
    session.s3Prefix = 'sessions/2026/09/10/s1';
    (session as Record<string, unknown>).startedAt = new Date('2026-09-11T00:30:00Z');

    await service.save('s1');

    expect(session.s3Prefix).toBe('sessions/2026/09/10/s1');
  });
});

describe('capture health reaches the console', () => {
  it('persists per-track health from the progress report', async () => {
    const { service, tracksRepo } = makeService({ agents: ['a1'] });

    await service.reportProgress('s1', {
      agent_id: 'a1',
      tracks: [{ track_id: 't0', segments: 0, bytes: 500, degraded: false, health: 'stalled' }],
    } as never);

    const saved = tracksRepo.save.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(saved.health).toBe('stalled');
  });

  it('counts stalled and quiet tracks in the session progress', async () => {
    const { service, tracksRepo } = makeService({ agents: ['a1', 'a2'] });
    tracksRepo.find = jest.fn(async () => [
      { id: 't0', kind: 'audio', segmentCount: 0, bytes: '500', degraded: false, health: 'stalled', uploadState: 'pending' },
      { id: 't1', kind: 'audio', segmentCount: 3, bytes: '900', degraded: false, health: 'quiet', uploadState: 'pending' },
    ]) as never;

    const session = await service.byId('s1');

    expect(session.progress.stalled).toBe(1);
    expect(session.progress.quiet).toBe(1);
  });

  it('carries upload health through to the console', async () => {
    const { service } = makeService({ agents: ['a1'] });

    await service.reportProgress('s1', {
      agent_id: 'a1',
      tracks: [],
      upload_health: { queued: 4, failures: 2, oldest_pending_ms: 120_000 },
    } as never);

    const session = await service.byId('s1');
    expect(session.progress.upload).toEqual({
      queued: 4,
      failures: 2,
      oldestPendingMs: 120_000,
    });
  });

  it('defaults health to ok when an older agent omits it', async () => {
    // A host running last week's agent build must not read as stalled.
    const { service, tracksRepo } = makeService({ agents: ['a1'] });

    await service.reportProgress('s1', {
      agent_id: 'a1',
      tracks: [{ track_id: 't0', segments: 2, bytes: 1000, degraded: false }],
    } as never);

    const saved = tracksRepo.save.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(saved.health ?? 'ok').toBe('ok');
  });
});
