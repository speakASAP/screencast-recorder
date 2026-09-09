import { Agent, AgentDeps } from './agent';

type TestDeps = AgentDeps & {
  posted: { path: string; body: any }[];
  captureStarts: number;
  stopped: boolean;
  api: AgentDeps['api'] & { failWith(error: Error | { status: number } | null): void };
  capture: AgentDeps['capture'] & { renderPreview: jest.Mock };
};

function makeDeps(
  overrides: Partial<AgentDeps> = {},
  // Merged into `capture` rather than replacing it: a test that only wants to
  // pin isRunning must not lose start, stop and upload along with it.
  captureOverrides: Partial<AgentDeps['capture']> = {},
): TestDeps {
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
      renderPreview: jest.fn(async () => ({ artifacts: [], sourcePath: 'local' as const })),
      isRunning: () => captureStarts > 0 && !stopped,
      states: () => [],
      currentWindow: () => 'nvim',
      probeCamera: jest.fn(async () => ({ hasSignal: true, detail: 'ok' })),
      ...captureOverrides,
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

describe('render-preview', () => {
  const command = {
    command_id: 'c1',
    type: 'render-preview' as const,
    session_id: 's1',
    payload: {
      prefix: 'sessions/2026/09/07/s1',
      audioSourceRefs: ['jabra', 'usb1', 'usb2'],
    },
  };

  const artifacts = [
    { kind: 'video', sourceRef: null, objectKey: 'p/preview/proxy.mp4', bytes: 529020, durationMs: 87837 },
    { kind: 'audio', sourceRef: 'jabra', objectKey: 'p/preview/audio-jabra.m4a', bytes: 23487, durationMs: 87830, meanDb: -91, maxDb: -91 },
    { kind: 'audio', sourceRef: 'usb1', objectKey: 'p/preview/audio-usb1.m4a', bytes: 24087, durationMs: 87884, meanDb: -91, maxDb: -91 },
    { kind: 'audio', sourceRef: 'usb2', objectKey: 'p/preview/audio-usb2.m4a', bytes: 282122, durationMs: 87883, meanDb: -57.2, maxDb: -20.3 },
  ];

  it('refuses to render while a recording is running', async () => {
    // A recording is unrepeatable; a render is always repeatable. When they
    // contend for GPU and disk the render loses, and that priority is
    // enforced here rather than left to timing.
    const deps = makeDeps({}, { isRunning: () => true });
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle(command as never);

    expect(deps.capture.renderPreview).not.toHaveBeenCalled();
    expect(deps.api.post).toHaveBeenCalledWith(
      '/api/sessions/s1/preview-complete',
      expect.objectContaining({ state: 'deferred', reason: 'capture_running' }),
    );
  });

  it('renders every audio source, not only the loudest', async () => {
    // The owner uses different headsets across sessions, so which source
    // carried signal varies. Rendering one would leave the right microphone
    // unreachable, and it would fail silently -- a preview that plays some
    // audio looks like it is working.
    const deps = makeDeps({}, { isRunning: () => false });
    deps.capture.renderPreview.mockResolvedValue({ artifacts, sourcePath: 'local' });
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle(command as never);

    expect(deps.capture.renderPreview).toHaveBeenCalledWith(
      's1',
      'sessions/2026/09/07/s1',
      ['jabra', 'usb1', 'usb2'],
    );
    const posted = (deps.api.post as jest.Mock).mock.calls.at(-1)![1] as any;
    expect(posted.artifacts.filter((a: { kind: string }) => a.kind === 'audio')).toHaveLength(3);
  });

  it('reports which source path it read from', async () => {
    const deps = makeDeps({}, { isRunning: () => false });
    deps.capture.renderPreview.mockResolvedValue({ artifacts, sourcePath: 'storage' });
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle(command as never);

    expect(deps.api.post).toHaveBeenCalledWith(
      '/api/sessions/s1/preview-complete',
      expect.objectContaining({ state: 'ready', source_path: 'storage' }),
    );
  });

  it('reports a failed render without touching anything else', async () => {
    const deps = makeDeps({}, { isRunning: () => false });
    deps.capture.renderPreview.mockRejectedValue(new Error('ffmpeg died'));
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle(command as never);

    expect(deps.api.post).toHaveBeenCalledWith(
      '/api/sessions/s1/preview-complete',
      expect.objectContaining({ state: 'failed', reason: 'render_failed' }),
    );
    expect(deps.stopped).toBe(false);
  });

  it('fails rather than guessing when the command carries no prefix', async () => {
    const deps = makeDeps({}, { isRunning: () => false });
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle({ ...command, payload: {} } as never);

    expect(deps.capture.renderPreview).not.toHaveBeenCalled();
    expect(deps.api.post).toHaveBeenCalledWith(
      '/api/sessions/s1/preview-complete',
      expect.objectContaining({ state: 'failed', reason: 'no_prefix' }),
    );
  });

  it('queues the report for redelivery when the API is unreachable', async () => {
    // The render already ran and its objects are in the bucket. Losing the
    // report would leave the row rendering forever with a finished proxy
    // sitting behind it.
    const deps = makeDeps({}, { isRunning: () => false });
    deps.capture.renderPreview.mockResolvedValue({ artifacts, sourcePath: 'local' });
    deps.api.failWith(new Error('connection refused'));
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle(command as never);

    expect(agent.hasPending()).toBe(true);
  });

  it('does not let a recording start be blocked by a render already refused', async () => {
    // The refusal path must be inert: it touches no capture state.
    const deps = makeDeps({}, {});
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });
    await agent.handle(command as never);
    await prepareAndStart(agent, 's2');
    expect(deps.captureStarts).toBe(1);
  });
});

describe('a camera with no signal never reaches T0', () => {
  const webcamTracks = [
    { track_id: 't1', kind: 'screen', source_ref: 'HDMI-A-0' },
    { track_id: 't2', kind: 'webcam', source_ref: '/dev/video9' },
  ];

  const noSignal = { probeCamera: jest.fn(async () => ({ hasSignal: false, detail: 'no signal from the camera' })) };

  it('fails prepare when the camera is delivering nothing', async () => {
    // A v4l2loopback node with no writer is listed by discovery and opens
    // without complaint. Without this check the session records an empty
    // webcam track and the operator finds out on playback, when the work
    // cannot be repeated.
    const deps = makeDeps({}, noSignal as never);
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'p', type: 'prepare', session_id: 's', payload: { tracks: webcamTracks },
    } as never);

    const status = deps.posted.find((p) => p.path.includes('/status'));
    expect(status?.body).toMatchObject({ state: 'failed', reason: 'camera_no_signal' });
  });

  it('names the device that had no signal', async () => {
    // Two cameras could be selected; "no signal" without saying which one
    // leaves the operator checking both.
    const deps = makeDeps({}, noSignal as never);
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'p', type: 'prepare', session_id: 's', payload: { tracks: webcamTracks },
    } as never);

    const status = deps.posted.find((p) => p.path.includes('/status'));
    expect((status?.body as { detail: string }).detail).toContain('/dev/video9');
  });

  it('never starts capture when the camera has no signal', async () => {
    // The point of failing in prepare is that T0 is never reached.
    const deps = makeDeps({}, noSignal as never);
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'p', type: 'prepare', session_id: 's', payload: { tracks: webcamTracks },
    } as never);
    await agent.handle({
      command_id: 'c', type: 'start', session_id: 's', payload: { t0: future() },
    } as never);

    expect(deps.captureStarts).toBe(0);
  });

  it('reports ready when the camera is delivering frames', async () => {
    const deps = makeDeps();
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'p', type: 'prepare', session_id: 's', payload: { tracks: webcamTracks },
    } as never);

    const status = deps.posted.find((p) => p.path.includes('/status'));
    expect(status?.body).toMatchObject({ state: 'ready' });
  });

  it('does not probe when no camera was selected', async () => {
    // Probing opens the device; doing it for a screen-only session would be
    // work with no question behind it.
    const probeCamera = jest.fn(async () => ({ hasSignal: true, detail: 'ok' }));
    const deps = makeDeps({}, { probeCamera } as never);
    const agent = new Agent(deps, { agentId: 'a', minFreeGb: 20 });

    await agent.handle({
      command_id: 'p', type: 'prepare', session_id: 's',
      payload: { tracks: [{ track_id: 't1', kind: 'screen', source_ref: 'HDMI-A-0' }] },
    } as never);

    expect(probeCamera).not.toHaveBeenCalled();
  });
});
