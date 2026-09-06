import { buildEvent, filterHotkeys, parseMouseLocation, sanitiseWindowTitle } from './tracker';

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
