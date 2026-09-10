import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { InputListener, parseXi2Line, XI2_ARGS } from './input-listener';

/** A stand-in for the `xinput test-xi2 --root` child process. */
class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(signal?: string): boolean {
    this.killed = true;
    this.emit('exit', null, signal ?? 'SIGTERM');
    return true;
  }
}

/**
 * Real output captured from `xinput test-xi2 --root` on this host while
 * pressing ctrl+shift+a, then a bare `a`, then clicking button 1.
 *
 * Kept verbatim rather than paraphrased: the parser's whole job is to cope
 * with this exact shape, and a tidied-up fixture would stop testing that.
 */
const REAL_XI2_OUTPUT = `EVENT type 13 (RawKeyPress)
    device: 3 (5)
    time:   278524995
    detail: 37
    valuators:

EVENT type 13 (RawKeyPress)
    device: 3 (5)
    time:   278525002
    detail: 50
    valuators:

EVENT type 13 (RawKeyPress)
    device: 3 (5)
    time:   278525009
    detail: 38
    valuators:

EVENT type 14 (RawKeyRelease)
    device: 3 (5)
    time:   278525015
    detail: 38
    valuators:

EVENT type 14 (RawKeyRelease)
    device: 3 (5)
    time:   278525015
    detail: 50
    valuators:

EVENT type 14 (RawKeyRelease)
    device: 3 (5)
    time:   278525016
    detail: 37
    valuators:

EVENT type 15 (RawButtonPress)
    device: 2 (4)
    time:   278525654
    detail: 1
    flags:\x20
    valuators:

EVENT type 16 (RawButtonRelease)
    device: 2 (4)
    time:   278525655
    detail: 1
    flags:\x20
    valuators:
`;

describe('the XInput2 line parser', () => {
  it('distinguishes a press from a release, and counts only presses', () => {
    // A release is recognised but is not a count -- counting both would double
    // every number. It exists only so a held modifier can be forgotten.
    expect(parseXi2Line('EVENT type 13 (RawKeyPress)')).toEqual({ kind: 'key' });
    expect(parseXi2Line('EVENT type 15 (RawButtonPress)')).toEqual({ kind: 'button' });
    expect(parseXi2Line('EVENT type 14 (RawKeyRelease)')).toEqual({ kind: 'release' });
    // A button release is nothing at all: buttons are never held as modifiers.
    expect(parseXi2Line('EVENT type 16 (RawButtonRelease)')).toBeNull();
  });

  it('does not classify the cooked events xinput prints alongside raw ones', () => {
    // These duplicate every raw event and carry their own detail lines.
    // Classifying them is what made hotkeys come out empty on real input.
    expect(parseXi2Line('EVENT type 2 (KeyPress)')).toBeNull();
    expect(parseXi2Line('EVENT type 3 (KeyRelease)')).toBeNull();
    expect(parseXi2Line('EVENT type 4 (ButtonPress)')).toBeNull();
  });

  it('reads a detail line as a bare number', () => {
    expect(parseXi2Line('    detail: 37')).toEqual({ kind: 'detail', code: 37 });
  });

  it('ignores every other line xinput prints', () => {
    for (const line of ['    device: 3 (5)', '    time:   278524995', '    valuators:', '', '    flags: ']) {
      expect(parseXi2Line(line)).toBeNull();
    }
  });
});

describe('the input listener', () => {
  const spawnFake = (proc: FakeProc) => () => proc as never;

  it('counts keypresses and clicks from real xinput output', () => {
    const proc = new FakeProc();
    let keys = 0;
    let clicks = 0;
    const listener = new InputListener({
      spawnFn: spawnFake(proc),
      onKey: () => (keys += 1),
      onClick: () => (clicks += 1),
    });
    listener.start();
    proc.stdout.write(REAL_XI2_OUTPUT);

    // ctrl, shift, a = 3 presses. Releases must not add to it.
    expect(keys).toBe(3);
    expect(clicks).toBe(1);
  });

  it('holds a modifier across the cooked KeyPress that xinput interleaves', () => {
    // Regression test for a defect found only on a live recording.
    //
    // `xinput test-xi2 --root` reports every key TWICE: once as
    // `EVENT type 13 (RawKeyPress)` and again as the cooked
    // `EVENT type 2 (KeyPress)`, and BOTH carry a `detail:` line. An earlier
    // version treated any unclaimed `detail:` as a release and cleared the
    // held modifier, so ctrl was forgotten before the next key arrived and
    // every hotkey came out empty on real input while the unit tests -- whose
    // fixtures omitted the cooked events -- stayed green.
    //
    // This fixture is a verbatim capture of ctrl+s from this host.
    const proc = new FakeProc();
    const hotkeys: (string | undefined)[] = [];
    const listener = new InputListener({
      spawnFn: spawnFake(proc),
      onKey: (hotkey) => hotkeys.push(hotkey),
      onClick: () => undefined,
    });
    listener.start();

    proc.stdout.write(`EVENT type 13 (RawKeyPress)
    device: 3 (5)
    detail: 37
    valuators:

EVENT type 2 (KeyPress)
    device: 5 (5)
    detail: 37
    modifiers: locked 0 latched 0 base 0 effective: 0
    valuators:

EVENT type 13 (RawKeyPress)
    device: 3 (5)
    detail: 39
    valuators:

EVENT type 2 (KeyPress)
    device: 5 (5)
    detail: 39
    modifiers: locked 0 latched 0 base 0x4 effective: 0x4
    valuators:
`);

    // ctrl counted with no combination, then `s` counted AS ctrl+key.
    expect(hotkeys).toEqual([undefined, 'ctrl+key']);
  });

  it('reports a modifier combination as a hotkey and a bare key as none', () => {
    const proc = new FakeProc();
    const hotkeys: (string | undefined)[] = [];
    const listener = new InputListener({
      spawnFn: spawnFake(proc),
      onKey: (hotkey) => hotkeys.push(hotkey),
      onClick: () => undefined,
    });
    listener.start();

    // ctrl (37) down, then s (39) down: the `s` press is a hotkey.
    proc.stdout.write('EVENT type 13 (RawKeyPress)\n    detail: 37\n');
    proc.stdout.write('EVENT type 13 (RawKeyPress)\n    detail: 39\n');
    // ctrl up, then a bare `a` (38): not a hotkey, only a count.
    proc.stdout.write('EVENT type 14 (RawKeyRelease)\n    detail: 37\n');
    proc.stdout.write('EVENT type 13 (RawKeyPress)\n    detail: 38\n');

    expect(hotkeys).toEqual([undefined, 'ctrl+key', undefined]);
  });

  it('names only the modifier, never the key that was pressed with it', () => {
    // THE constitutional assertion. A hotkey is "which modifiers were held",
    // and the key itself is always the literal placeholder `key`. Recording
    // `ctrl+s` versus `ctrl+a` would distinguish two keystrokes, which is
    // content. The distinction between a save and an open is not worth a
    // mechanism that can spell.
    const proc = new FakeProc();
    const hotkeys: (string | undefined)[] = [];
    const listener = new InputListener({
      spawnFn: spawnFake(proc),
      onKey: (hotkey) => hotkeys.push(hotkey),
      onClick: () => undefined,
    });
    listener.start();

    proc.stdout.write('EVENT type 13 (RawKeyPress)\n    detail: 133\n'); // super
    proc.stdout.write('EVENT type 13 (RawKeyPress)\n    detail: 64\n'); // alt
    proc.stdout.write('EVENT type 13 (RawKeyPress)\n    detail: 38\n'); // `a`

    expect(hotkeys[2]).toBe('alt+super+key');
    // No keycode and no character reaches the caller.
    for (const hotkey of hotkeys) {
      expect(hotkey ?? '').not.toMatch(/[0-9]/);
      expect(hotkey ?? '').not.toMatch(/\+[a-z]$/);
    }
  });

  it('never passes a keycode to the caller', () => {
    // Every keycode 8..255 pressed alone must produce an undefined hotkey and
    // a bare count. If any keycode leaked through as an identity, this fails.
    const proc = new FakeProc();
    const seen: (string | undefined)[] = [];
    const listener = new InputListener({
      spawnFn: spawnFake(proc),
      onKey: (hotkey) => seen.push(hotkey),
      onClick: () => undefined,
    });
    listener.start();

    for (let code = 8; code < 256; code += 1) {
      proc.stdout.write(`EVENT type 13 (RawKeyPress)\n    detail: ${code}\n`);
      proc.stdout.write(`EVENT type 14 (RawKeyRelease)\n    detail: ${code}\n`);
    }

    expect(seen).toHaveLength(248);
    // Modifier keycodes pressed alone still report undefined: a modifier on its
    // own is not a combination.
    expect(seen.every((hotkey) => hotkey === undefined)).toBe(true);
  });

  it('handles output split across chunk boundaries', () => {
    // A pipe delivers arbitrary chunks. Splitting mid-line must not drop or
    // duplicate an event.
    const proc = new FakeProc();
    let keys = 0;
    const listener = new InputListener({
      spawnFn: spawnFake(proc),
      onKey: () => (keys += 1),
      onClick: () => undefined,
    });
    listener.start();

    const text = 'EVENT type 13 (RawKeyPress)\n    detail: 38\n'.repeat(10);
    for (let i = 0; i < text.length; i += 7) proc.stdout.write(text.slice(i, i + 7));

    expect(keys).toBe(10);
  });

  it('survives the child dying without throwing', () => {
    // Capture must never be interrupted by input monitoring. A dead listener
    // degrades to zero counts; it does not take ffmpeg down with it.
    const proc = new FakeProc();
    const listener = new InputListener({
      spawnFn: spawnFake(proc),
      onKey: () => undefined,
      onClick: () => undefined,
    });
    listener.start();

    expect(() => proc.emit('error', new Error('ENOENT: xinput not found'))).not.toThrow();
    expect(() => proc.emit('exit', 1, null)).not.toThrow();
    expect(listener.isRunning()).toBe(false);
  });

  it('degrades to zero counts when xinput cannot be spawned at all', () => {
    const listener = new InputListener({
      spawnFn: () => {
        throw new Error('spawn ENOENT');
      },
      onKey: () => undefined,
      onClick: () => undefined,
      onError: () => undefined,
    });

    expect(() => listener.start()).not.toThrow();
    expect(listener.isRunning()).toBe(false);
  });

  it('does not restart the child after a deliberate stop', () => {
    const proc = new FakeProc();
    const listener = new InputListener({
      spawnFn: spawnFake(proc),
      onKey: () => undefined,
      onClick: () => undefined,
    });
    listener.start();
    listener.stop();

    expect(proc.killed).toBe(true);
    expect(listener.isRunning()).toBe(false);
  });

  it('asks xinput only for raw root events', () => {
    // `--root` is what makes this a session-wide count rather than a per-window
    // one, and the whole argument vector is pinned so a future edit that adds a
    // keymap-resolving flag has to change a test that says why.
    expect(XI2_ARGS).toEqual(['test-xi2', '--root']);
  });
});

describe('xinput is given a display to connect to', () => {
  it('passes DISPLAY explicitly rather than trusting the environment', () => {
    // systemd --user does NOT inherit the session's DISPLAY. Without it
    // `xinput` reports "Unable to connect to X server" and delivers nothing,
    // which is why every recorded session read keys: 0, clicks: 0 while the
    // screen capture -- which passes its display explicitly -- worked fine.
    //
    // Asserted through the real default spawnFn, not a stub: the whole point
    // is what the listener hands to node's spawn.
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const listener = new InputListener({
      onKey: () => {},
      onClick: () => {},
      spawnFn: (_command, _args, options) => {
        seenEnv = options?.env;
        return {
          stdout: { on: () => {}, setEncoding: () => {} },
          stderr: { on: () => {} },
          on: () => {},
          kill: () => {},
        } as never;
      },
    });

    listener.start();
    listener.stop();
    expect(seenEnv?.DISPLAY).toBe(process.env.DISPLAY ?? ':0');
  });
});
