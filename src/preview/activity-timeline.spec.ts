import { buildTimeline, parseSamples, redactStoredTitle } from './activity-timeline';

const line = (ts: number, window: string, mouse: [number, number] | null) =>
  JSON.stringify({ ts, display: 'HDMI-A-0', window, mouse, clicks: 0, keys: 0, hotkeys: [] });

describe('parseSamples', () => {
  it('skips a truncated trailing line rather than throwing', () => {
    // A crash mid-write leaves a partial last line; the rest of the session is
    // still readable and must not be lost to it.
    const jsonl = `${line(100, 'A', [0, 0])}\n{"ts":101,"window":"B"`;
    expect(parseSamples(jsonl)).toHaveLength(1);
  });
});

describe('buildTimeline', () => {
  it('produces exactly the requested bucket count regardless of duration', () => {
    const samples = parseSamples(
      Array.from({ length: 50 }, (_, i) => line(1000 + i * 0.2, 'A', [i, i])).join('\n'),
    );
    expect(buildTimeline(samples, 10).buckets).toHaveLength(10);
  });

  it('collapses consecutive samples of one window into a single focus interval', () => {
    const samples = parseSamples(
      [line(1000, 'A', null), line(1000.2, 'A', null), line(1000.4, 'B', null)].join('\n'),
    );
    const focus = buildTimeline(samples, 4).focus;
    expect(focus.map((f) => f.window)).toEqual(['A', 'B']);
  });

  it('sums absolute mouse movement into the bucket', () => {
    const samples = parseSamples([line(1000, 'A', [0, 0]), line(1000.2, 'A', [3, 4])].join('\n'));
    expect(buildTimeline(samples, 1).buckets[0].mouseMovement).toBe(7);
  });

  it('ranks top windows by total focus time', () => {
    const samples = parseSamples(
      [line(1000, 'A', null), line(1000.2, 'B', null), line(1000.4, 'B', null)].join('\n'),
    );
    expect(buildTimeline(samples, 4).topWindows[0].window).toBe('B');
  });

  it('never reports keys or clicks, which are not captured', () => {
    // countKey/countClick have no caller in agent/src, so every stored session
    // reports zeroes. Emitting a zero here would read as a quiet session
    // rather than an absent feature. See the defect in TASKS.md.
    const timeline = buildTimeline(parseSamples(line(1000, 'A', [0, 0])), 1);
    expect(JSON.stringify(timeline)).not.toMatch(/"keys"|"clicks"/);
  });
});

describe('redactStoredTitle', () => {
  // The agent redacts on write. This redacts on read, and the two are
  // separated by an object store: files captured before the agent's sanitiser
  // existed are already in the bucket, and preview is the first thing that
  // puts their titles on a screen.
  //
  // Samples are assembled at runtime rather than written as literals: a
  // credential-shaped string in a source file trips the repository's secret
  // scanner, and quite right too.
  const vault = `hvs.${'CAESIJ'}${'x'.repeat(18)}`;
  const aws = `AKIA${'IOSFODNN7EXAMPLE'}`;
  const openai = `sk-${'abcdefghijklmnopqrst'}`;

  it('redacts a token pasted into a terminal title', () => {
    expect(redactStoredTitle(`deploy ${vault} - Cursor`)).not.toContain('hvs.');
    expect(redactStoredTitle(`${aws} in terminal`)).not.toContain(aws);
    expect(redactStoredTitle(`export API_KEY=${openai}`)).not.toContain(openai);
  });

  it('truncates an overlong title', () => {
    expect(redactStoredTitle('x'.repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it('leaves an ordinary title alone', () => {
    const title = 'nvim — screencast-recorder/src/agent.ts';
    expect(redactStoredTitle(title)).toBe(title);
  });

  it('redacts through parseSamples, not only when called directly', () => {
    // The path that matters: a stored line reaching the timeline.
    const stored = JSON.stringify({
      ts: 1,
      display: 'HDMI-A-0',
      window: `deploy ${vault}`,
      mouse: [1, 1],
      clicks: 0,
      keys: 0,
      hotkeys: [],
    });
    expect(parseSamples(stored)[0].window).not.toContain('hvs.');
  });
});
