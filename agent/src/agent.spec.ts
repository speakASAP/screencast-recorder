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

describe('command idempotency', () => {
  it('ignores a redelivered command_id', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

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
    await agent.handle({
      command_id: 'c1', type: 'start', session_id: 's', payload: { t0: future() },
    } as never);

    deps.api.failWith(new Error('ECONNREFUSED'));
    await agent.tick();

    // Local media is the source of truth; the controller is not a dependency.
    expect(deps.capture.isRunning()).toBe(true);
    expect(deps.stopped).toBe(false);
  });

  it('queues progress reports during an outage and flushes them on reconnect', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });
    await agent.handle({
      command_id: 'c1', type: 'start', session_id: 's', payload: { t0: future() },
    } as never);

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
    await agent.handle({
      command_id: 'c1', type: 'start', session_id: 's', payload: { t0: future() },
    } as never);

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
    await agent.handle({
      command_id: 'c1', type: 'start', session_id: 's', payload: { t0: future() },
    } as never);

    (deps.disk.freeBytes as jest.Mock).mockResolvedValue(1e9);
    await agent.tick();

    // A graceful stop finalises the segments. Letting ffmpeg hit a full disk
    // corrupts the tail of the recording.
    expect(deps.capture.stop).toHaveBeenCalled();
    const status = deps.posted.find((p) => p.body?.reason === 'disk_below_threshold');
    expect(status).toBeDefined();
  });
});
