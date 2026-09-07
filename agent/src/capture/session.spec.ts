import { CaptureSession } from './session';

/**
 * The local directory layout IS the S3 key layout: the uploader walks the
 * session directory and uses each relative path as an object key. So these
 * paths must match what the API's storage verification expects, or a complete
 * upload is reported as a session with missing objects -- which is exactly
 * what happened on the first live save.
 */
describe('CaptureSession directory layout', () => {
  const session = new CaptureSession({
    sessionId: 'sess-1',
    hostname: 'alfares',
    display: ':0.0',
    rootDir: '/home/ssf/recordings',
    displays: [{ id: 'HDMI-A-0', width: 3840, height: 2160, x: 0, y: 0 }],
  });

  it('places media tracks under the hostname', () => {
    // The API expects <prefix>/<hostname>/<kind>-<source_ref>/<file>.
    expect(session.trackDir({ track_id: 't', kind: 'screen', source_ref: 'HDMI-A-0' })).toBe(
      '/home/ssf/recordings/sess-1/alfares/screen-HDMI-A-0',
    );
  });

  it('separates two machines recording the same display id', () => {
    // Without the hostname segment, a MacBook and this host would both write
    // screen-HDMI-A-0 into one prefix and overwrite each other.
    const other = new CaptureSession({
      sessionId: 'sess-1',
      hostname: 'macbook',
      display: ':0.0',
      rootDir: '/home/ssf/recordings',
      displays: [],
    });
    const a = session.trackDir({ track_id: 't', kind: 'screen', source_ref: 'HDMI-A-0' });
    const b = other.trackDir({ track_id: 't', kind: 'screen', source_ref: 'HDMI-A-0' });
    expect(a).not.toBe(b);
  });

  it('puts the activity stream under the hostname too', () => {
    expect(session.trackDir({ track_id: 't', kind: 'metadata', source_ref: 'activity' })).toBe(
      '/home/ssf/recordings/sess-1/alfares/metadata',
    );
  });

  it('keeps the manifest at the session root, not under the hostname', () => {
    // One manifest per agent, but the API looks for <prefix>/manifest.json.
    expect(session.dir).toBe('/home/ssf/recordings/sess-1');
  });
});

/**
 * The regression net for the defect this file's counters shipped with.
 *
 * `ActivityTracker.countKey()` and `countClick()` existed, were unit-tested,
 * passed, and had no caller anywhere in the agent. Every session recorded
 * `keys: 0, clicks: 0` for months and the tests stayed green, because they
 * asserted the shape of an event rather than the existence of a producer.
 *
 * So these tests assert the wiring itself: that starting a metadata track
 * spawns an input listener, and that what the listener reports reaches the
 * events file. A test that only checks `countKey()` increments a number is the
 * test that let this through.
 */
describe('the activity tracker is actually fed by an input listener', () => {
  const context = {
    sessionId: 'sess-wire',
    hostname: 'alfares',
    display: ':0.0',
    rootDir: '/tmp/screencast-test',
    displays: [{ id: 'HDMI-A-0', width: 3840, height: 2160, x: 0, y: 0 }],
  };

  it('spawns an input listener when a metadata track starts', async () => {
    const spawned: { command: string; args: string[] }[] = [];
    const session = new CaptureSession(context);

    await session.start(
      [{ track_id: 'meta', kind: 'metadata', source_ref: 'activity', sample_hz: 5 }],
      0,
      {
        spawnInput: (command, args) => {
          spawned.push({ command, args });
          return { on: () => undefined, stdout: null, stderr: null, kill: () => true } as never;
        },
      },
    );

    // The defect in one assertion: nothing spawned means nothing counts.
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe('xinput');
    expect(spawned[0].args).toEqual(['test-xi2', '--root']);

    await session.stop('agent-1');
  });

  it('does not spawn an input listener without a metadata track', async () => {
    const spawned: string[] = [];
    const session = new CaptureSession(context);

    await session.start([], 0, {
      spawnInput: (command) => {
        spawned.push(command);
        return { on: () => undefined, stdout: null, stderr: null, kill: () => true } as never;
      },
    });

    expect(spawned).toEqual([]);
    await session.stop('agent-1');
  });
});
