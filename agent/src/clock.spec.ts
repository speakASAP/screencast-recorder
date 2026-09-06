import { T0_TOLERANCE_MS, msUntil, parseChronyTracking, t0Missed, waitUntil } from './clock';

describe('parseChronyTracking', () => {
  it('parses real chronyc tracking output from this host', () => {
    // Verbatim from alfares.
    const out = [
      'Reference ID    : 6DE048AF (175-72-224-109.m-zone.cz)',
      'Stratum         : 2',
      'Ref time (UTC)  : Sun Sep 06 20:58:06 2026',
      'System time     : 0.000856309 seconds fast of NTP time',
      'Last offset     : +0.000393764 seconds',
      'Leap status     : Normal',
    ].join('\n');

    const state = parseChronyTracking(out);
    expect(state.synchronised).toBe(true);
    expect(state.offset_ms).toBe(1);
    expect(state.source).toBe('6DE048AF');
  });

  it('signs a slow clock negative and a fast clock positive', () => {
    // The direction matters: a later editing stage uses this offset to align
    // tracks from different machines, and the wrong sign doubles the error.
    const fast = parseChronyTracking(
      'System time     : 0.250000000 seconds fast of NTP time\nLeap status     : Normal',
    );
    const slow = parseChronyTracking(
      'System time     : 0.250000000 seconds slow of NTP time\nLeap status     : Normal',
    );
    expect(fast.offset_ms).toBe(250);
    expect(slow.offset_ms).toBe(-250);
  });

  it('treats an unsynchronised leap status as not ready', () => {
    // Starting unsynchronised silently misaligns every track in the session.
    const out = 'System time     : 0.000001 seconds fast of NTP time\nLeap status     : Not synchronised';
    expect(parseChronyTracking(out).synchronised).toBe(false);
  });

  it('treats a large offset as not ready even when the leap status is normal', () => {
    // chrony can report Normal while still far out after a resume from suspend.
    const out = 'System time     : 5.000000 seconds fast of NTP time\nLeap status     : Normal';
    expect(parseChronyTracking(out).synchronised).toBe(false);
  });

  it('reports not synchronised when chrony is unavailable', () => {
    expect(parseChronyTracking('')).toEqual({
      synchronised: false,
      offset_ms: 0,
      source: 'unavailable',
    });
  });

  it('does not claim synchronisation from unparseable output', () => {
    expect(parseChronyTracking('506 Cannot talk to daemon').synchronised).toBe(false);
  });
});

describe('T0 scheduling', () => {
  it('computes a positive wait for a future t0', () => {
    expect(msUntil(new Date(Date.now() + 5000))).toBeGreaterThan(4000);
  });

  it('reports t0_missed rather than starting late', () => {
    const past = new Date(Date.now() - T0_TOLERANCE_MS - 1000);
    expect(t0Missed(past)).toBe(true);
  });

  it('accepts a t0 that has just passed, within tolerance', () => {
    // The command may take a moment to arrive; a few milliseconds late is not
    // worth abandoning a session over.
    expect(t0Missed(new Date(Date.now() - 100))).toBe(false);
  });

  it('returns immediately for a t0 already past', async () => {
    const before = Date.now();
    await waitUntil(new Date(Date.now() - 1000));
    expect(Date.now() - before).toBeLessThan(50);
  });

  it('waits until close to t0 before returning', async () => {
    const t0 = new Date(Date.now() + 120);
    await waitUntil(t0);
    // The spin phase should land it on or just after t0, not early.
    expect(Date.now()).toBeGreaterThanOrEqual(t0.getTime());
    expect(Date.now() - t0.getTime()).toBeLessThan(60);
  });
});
