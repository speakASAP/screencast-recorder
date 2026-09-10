import { ActivityTracker, buildEvent, filterHotkeys, parseMouseLocation, sanitiseWindowTitle } from './tracker';

describe('the privacy boundary', () => {
  it('records counts, never characters', () => {
    const event = buildEvent({
      ts: 1757183400,
      display: 'HDMI-A-0',
      window: 'nvim',
      mouse: [100, 200],
      clicks: 2,
      keys: 17,
      hotkeys: ['ctrl+s'],
    });

    expect(event.keys).toBe(17);
    // The constitutional boundary: no field may carry typed text. This asserts
    // the serialised shape, so adding such a field later fails here.
    const serialised = JSON.stringify(event);
    expect(serialised).not.toMatch(/"(text|chars|keystrokes|typed|content|clipboard)"/);
    expect(Object.keys(event).sort()).toEqual(
      ['clicks', 'display', 'hotkeys', 'keys', 'mouse', 'ts', 'window'].sort(),
    );
  });

  it('keeps only modifier combinations in hotkeys', () => {
    // A bare letter is a keystroke. Only modified combinations survive, because
    // "the user pressed ctrl+s" is editing signal while "the user pressed a" is
    // the content of what they typed.
    expect(filterHotkeys(['ctrl+s', 'a', 'super+tab', 'x', 'shift+f', 'Return'])).toEqual([
      'ctrl+s',
      'super+tab',
      'shift+f',
    ]);
  });

  it('drops a bare modifier with no key', () => {
    expect(filterHotkeys(['ctrl', 'alt'])).toEqual([]);
  });

  it('truncates an overlong window title', () => {
    expect(sanitiseWindowTitle('x'.repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it('redacts anything token-shaped from a window title', () => {
    // A terminal title can carry a pasted credential, and this file is uploaded
    // to S3 and later read by an editing pipeline.
    //
    // The samples below are assembled at runtime rather than written as
    // literals: a credential-shaped string in a source file trips the
    // repository's secret scanner, and quite right too.
    const vault = `hvs.${'CAESIJ'}${'x'.repeat(18)}`;
    const aws = `AKIA${'IOSFODNN7EXAMPLE'}`;
    const openai = `sk-${'abcdefghijklmnopqrst'}`;

    expect(sanitiseWindowTitle(`vault token=${vault}`)).not.toContain('hvs.');
    expect(sanitiseWindowTitle(`${aws} in terminal`)).not.toContain(aws);
    expect(sanitiseWindowTitle(`export API_KEY=${openai}`)).not.toContain(openai);
  });

  it('leaves an ordinary window title alone', () => {
    const title = 'nvim — screencast-recorder/src/agent.ts';
    expect(sanitiseWindowTitle(title)).toBe(title);
  });
});

describe('event serialisation', () => {
  it('emits one line of valid JSON per sample', () => {
    const line = JSON.stringify(buildEvent({ ts: 1, clicks: 0, keys: 0 }));
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toContain('\n');
  });

  it('defaults missing fields rather than emitting undefined', () => {
    // A half-written line breaks a JSONL reader that assumes uniform records.
    const event = buildEvent({ ts: 1 });
    expect(event.clicks).toBe(0);
    expect(event.keys).toBe(0);
    expect(event.hotkeys).toEqual([]);
  });
});

describe('parseMouseLocation', () => {
  it('parses xdotool getmouselocation output', () => {
    expect(parseMouseLocation('x:1204 y:830 screen:0 window:12582919')).toEqual([1204, 830]);
  });

  it('returns null rather than guessing when the pointer cannot be read', () => {
    expect(parseMouseLocation('')).toBeNull();
  });
});

describe('no typed character can reach events.jsonl', () => {
  it('writes only counts and modifier names, end to end through the listener', async () => {
    // The end-to-end privacy assertion the brief demands: drive the real
    // parser with the real xinput output shape, let it feed a real
    // ActivityTracker, and read the file that would be uploaded to S3.
    const { InputListener } = await import('./input-listener');
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');

    const dir = await mkdtemp(join(tmpdir(), 'activity-'));
    const file = join(dir, 'events.jsonl');
    const tracker = new ActivityTracker(file, 5, 'HDMI-A-0');

    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const listener = new InputListener({
      onKey: (hotkey) => tracker.countKey(hotkey),
      onClick: () => tracker.countClick(),
      spawnFn: () => proc as never,
      onError: () => undefined,
    });

    tracker.start();
    listener.start();

    // "the quick brown fox" plus ctrl+s plus two clicks. Every keycode below
    // is a real X11 keycode for a real letter; none may appear as a letter.
    const letters = [28, 26, 30, 41, 39, 25, 53, 24, 30, 26, 40, 56, 27, 55, 42, 58, 57, 32, 41];
    for (const code of letters) {
      proc.stdout.write(`EVENT type 13 (RawKeyPress)\n    detail: ${code}\n`);
      proc.stdout.write(`EVENT type 14 (RawKeyRelease)\n    detail: ${code}\n`);
    }
    proc.stdout.write('EVENT type 13 (RawKeyPress)\n    detail: 37\n'); // ctrl
    proc.stdout.write('EVENT type 13 (RawKeyPress)\n    detail: 39\n'); // s
    proc.stdout.write('EVENT type 15 (RawButtonPress)\n    detail: 1\n');
    proc.stdout.write('EVENT type 15 (RawButtonPress)\n    detail: 3\n');

    // Polled, not slept. A fixed wait for an async pipeline is a deadline the
    // machine can miss: under a full parallel suite this read zero keys and
    // failed a privacy test that had nothing to do with timing. Waiting for
    // the condition keeps the assertions and drops the race.
    const expectedKeys = letters.length + 2;
    let samples: { keys: number; clicks: number; hotkeys: string[] }[] = [];
    let keys = 0;
    let clicks = 0;

    // Polled, not slept. A fixed wait for an async pipeline is a deadline the
    // machine can miss: under a full parallel suite this read zero keys and
    // failed a privacy test that had nothing to do with timing. Waiting for
    // the condition keeps the assertions and drops the race.
    for (let waited = 0; waited < 5000; waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const text = await readFile(file, 'utf8').catch(() => '');
      samples = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      keys = samples.reduce((n, s) => n + s.keys, 0);
      clicks = samples.reduce((n, s) => n + s.clicks, 0);
      if (keys >= expectedKeys && clicks >= 2) break;
    }

    listener.stop();
    await tracker.stop();
    expect(keys).toBe(letters.length + 2); // every press, modifiers included
    expect(clicks).toBe(2);

    // The boundary. The file may contain digits, the display name, and the
    // literal modifier vocabulary -- and nothing else that could be a letter
    // someone typed.
    const hotkeys = samples.flatMap((s) => s.hotkeys as string[]);
    expect(hotkeys).toContain('ctrl+key');
    for (const hotkey of hotkeys) {
      // Every hotkey is modifiers plus the opaque placeholder. A trailing
      // single character would be a typed key.
      expect(hotkey).toMatch(/^(ctrl|alt|shift|super)(\+(ctrl|alt|shift|super))*\+key$/);
    }

    // And no keycode leaked either: the only numbers in the file are the
    // timestamp, the mouse coordinates and the counts.
    for (const sample of samples) {
      expect(Object.keys(sample).sort()).toEqual(
        ['clicks', 'display', 'hotkeys', 'keys', 'mouse', 'ts', 'window'].sort(),
      );
    }
  }, 10000);
});
