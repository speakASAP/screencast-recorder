import { Agent, AgentDeps } from './agent';

type TestDeps = AgentDeps & {
  posted: { path: string; body: any }[];
  captureStarts: number;
  stopped: boolean;
  api: AgentDeps['api'] & { failWith(error: Error | { status: number } | null): void };
};

function makeDeps(overrides: Partial<AgentDeps> = {}): TestDeps {
  const posted: { path: string; body: any }[] = [];
  let failure: Error | { status: number } | null = null;
  let captureStarts = 0;
  let stopped = false;

  const deps = {
    posted,
    get captureStarts() {
      return captureStarts;
    },
    get stopped() {
      return stopped;
    },

    api: {
      post: jest.fn(async (path: string, body: unknown) => {
        if (failure) throw failure;
        posted.push({ path, body });
        return {};
      }),
      nextCommand: jest.fn(async () => null),
      failWith: (error: Error | { status: number } | null) => {
        failure = error;
      },
    },

    capture: {
      start: jest.fn(async () => {
        captureStarts += 1;
      }),
      stop: jest.fn(async () => {
        stopped = true;
      }),
      upload: jest.fn(async () => ({ objects: 4, bytes: 1234, verified: true })),
      isRunning: () => captureStarts > 0 && !stopped,
      states: () => [],
      currentWindow: () => 'nvim',
    },

    clock: {
      check: jest.fn(async () => ({ synchronised: true, offset_ms: 1, source: 'chrony' })),
    },

    disk: { freeBytes: jest.fn(async () => 500e9) },

    reloadCredentials: jest.fn(async () => undefined),

    ...overrides,
  };

  return deps as never;
}

const future = () => new Date(Date.now() + 1000).toISOString();
const longPast = () => new Date(Date.now() - 60_000).toISOString();

/** prepare + start, as the real protocol sequences them. */
async function prepareAndStart(agent: Agent, sessionId = 's'): Promise<void> {
  await agent.handle({
    command_id: `p-${sessionId}`, type: 'prepare', session_id: sessionId,
    payload: { tracks: [{ track_id: 't1', kind: 'screen', source_ref: 'HDMI-A-0' }] },
  } as never);
  await agent.handle({
    command_id: `c-${sessionId}`, type: 'start', session_id: sessionId,
    payload: { t0: future() },
  } as never);
}

describe('command idempotency', () => {
  it('ignores a redelivered command_id', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'p1', type: 'prepare', session_id: 's',
      payload: { tracks: [{ track_id: 't1', kind: 'screen', source_ref: 'HDMI-A-0' }] },
    } as never);

    const command = { command_id: 'c1', type: 'start', session_id: 's', payload: { t0: future() } };
    await agent.handle(command as never);
    await agent.handle(command as never);

    // At-least-once delivery must not produce two ffmpeg trees writing to the
    // same directory.
    expect(deps.captureStarts).toBe(1);
  });
});

describe('resilience to a controller outage', () => {
  it('keeps recording when the API is unreachable', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });
    await prepareAndStart(agent);

    deps.api.failWith(new Error('ECONNREFUSED'));
    await agent.tick();

    // Local media is the source of truth; the controller is not a dependency.
    expect(deps.capture.isRunning()).toBe(true);
    expect(deps.stopped).toBe(false);
  });

  it('queues progress reports during an outage and flushes them on reconnect', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });
    await prepareAndStart(agent);

    deps.api.failWith(new Error('ECONNREFUSED'));
    await agent.tick();
    await agent.tick();
    const duringOutage = deps.posted.length;

    deps.api.failWith(null);
    await agent.tick();

    expect(deps.posted.length).toBeGreaterThan(duringOutage);
  });

  it('re-reads the token once on 401 and keeps recording', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });
    await prepareAndStart(agent);

    deps.api.failWith({ status: 401 });
    await agent.tick();

    expect(deps.reloadCredentials).toHaveBeenCalledTimes(1);
    expect(deps.capture.isRunning()).toBe(true);
  });
});

describe('the start barrier', () => {
  it('reports t0_missed instead of starting late', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'c', type: 'start', session_id: 's', payload: { t0: longPast() },
    } as never);

    // Joining late produces tracks that silently disagree with every other
    // track's timeline, which is worse than not recording.
    expect(deps.captureStarts).toBe(0);
    const status = deps.posted.find((p) => p.path.includes('/status'));
    expect(status?.body).toMatchObject({ state: 'failed', reason: 't0_missed' });
  });

  it('refuses to report ready when the clock is unsynchronised', async () => {
    const deps = makeDeps({
      clock: { check: jest.fn(async () => ({ synchronised: false, offset_ms: 4000, source: 'x' })) },
    } as never);
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'p', type: 'prepare', session_id: 's', payload: { tracks: [] },
    } as never);

    const status = deps.posted.find((p) => p.path.includes('/status'));
    expect(status?.body).toMatchObject({ state: 'failed', reason: 'clock_unsynchronised' });
  });

  it('refuses to prepare when free disk is below the floor', async () => {
    const deps = makeDeps({ disk: { freeBytes: jest.fn(async () => 2e9) } } as never);
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'p', type: 'prepare', session_id: 's', payload: { tracks: [] },
    } as never);

    const status = deps.posted.find((p) => p.path.includes('/status'));
    expect(status?.body).toMatchObject({ state: 'failed', reason: 'disk_below_threshold' });
  });
});

describe('disk safety during a recording', () => {
  it('stops gracefully when free disk reaches the floor', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });
    await prepareAndStart(agent);

    (deps.disk.freeBytes as jest.Mock).mockResolvedValue(1e9);
    await agent.tick();

    // A graceful stop finalises the segments. Letting ffmpeg hit a full disk
    // corrupts the tail of the recording.
    expect(deps.capture.stop).toHaveBeenCalled();
    const status = deps.posted.find((p) => p.body?.reason === 'disk_below_threshold');
    expect(status).toBeDefined();
  });
});

describe('tracks come from prepare, not from start', () => {
  it('captures the tracks prepare supplied when start carries only t0', async () => {
    // The live failure this pins: start's payload is only t0 by contract, so an
    // agent reading tracks from it started nothing and still reported
    // "recording" -- the operator watched a session capturing nothing.
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'p', type: 'prepare', session_id: 's',
      payload: { tracks: [{ track_id: 't1', kind: 'screen', source_ref: 'HDMI-A-0' }] },
    } as never);
    await agent.handle({
      command_id: 'c', type: 'start', session_id: 's', payload: { t0: future() },
    } as never);

    expect(deps.captureStarts).toBe(1);
    const started = (deps.capture.start as jest.Mock).mock.calls[0][1] as unknown[];
    expect(started).toHaveLength(1);
  });

  it('fails rather than reporting recording when no tracks were prepared', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'c', type: 'start', session_id: 's', payload: { t0: future() },
    } as never);

    expect(deps.captureStarts).toBe(0);
    const status = deps.posted.find((p) => p.path.includes('/status'));
    expect(status?.body).toMatchObject({ state: 'failed', reason: 'no_tracks_prepared' });
  });

  it('reports ffmpeg_failed rather than recording when capture throws', async () => {
    // Claiming "recording" after a failed spawn is the same class of lie.
    const deps = makeDeps();
    (deps.capture.start as jest.Mock).mockRejectedValueOnce(new Error('display gone'));
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'p', type: 'prepare', session_id: 's',
      payload: { tracks: [{ track_id: 't1' }] },
    } as never);
    await agent.handle({
      command_id: 'c', type: 'start', session_id: 's', payload: { t0: future() },
    } as never);

    const statuses = deps.posted.filter((p) => p.path.includes('/status'));
    expect(statuses.some((s) => s.body.state === 'recording')).toBe(false);
    expect(statuses.some((s) => s.body.reason === 'ffmpeg_failed')).toBe(true);
  });
});

describe('the upload command', () => {
  it('uploads under the prefix the API supplied and reports what it saw', async () => {
    // The `upload` case was missing from the switch entirely, so Save moved the
    // session to `uploading` and the agent silently ignored it: nothing was
    // ever sent, and the session sat there for ever.
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'u', type: 'upload', session_id: 's',
      payload: { prefix: 'sessions/2026/09/07/s' },
    } as never);

    expect(deps.capture.upload).toHaveBeenCalledWith('s', 'sessions/2026/09/07/s');
    const posted = deps.posted.find((p) => p.path.includes('upload-complete'));
    expect(posted?.body).toMatchObject({ objects: 4, verified: true });
  });

  it('reports the verdict it observed rather than assuming success', async () => {
    const deps = makeDeps();
    (deps.capture.upload as jest.Mock).mockResolvedValueOnce({
      objects: 4, bytes: 1, verified: false,
    });
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'u', type: 'upload', session_id: 's', payload: { prefix: 'p' },
    } as never);

    const posted = deps.posted.find((p) => p.path.includes('upload-complete'));
    expect(posted?.body).toMatchObject({ verified: false });
  });

  it('fails loudly when the upload throws, leaving local media untouched', async () => {
    const deps = makeDeps();
    (deps.capture.upload as jest.Mock).mockRejectedValueOnce(new Error('connection reset'));
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'u', type: 'upload', session_id: 's', payload: { prefix: 'p' },
    } as never);

    const status = deps.posted.find((p) => p.body?.reason === 'upload_failed');
    expect(status).toBeDefined();
  });

  it('refuses an upload command with no prefix', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'u', type: 'upload', session_id: 's', payload: {},
    } as never);

    expect(deps.capture.upload).not.toHaveBeenCalled();
    expect(deps.posted.find((p) => p.body?.reason === 'no_upload_prefix')).toBeDefined();
  });
});
