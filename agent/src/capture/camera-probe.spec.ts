import { buildProbeArgs, isNoSignal } from './camera-probe';

describe('buildProbeArgs', () => {
  const args = buildProbeArgs('/dev/video9').join(' ');

  it('reads exactly one frame and discards it', () => {
    // The probe answers whether frames arrive at all. Writing a file would
    // make it a capture, with somewhere to put the output and something to
    // clean up afterwards.
    expect(args).toContain('-frames:v 1');
    expect(args).toContain('-f null');
  });

  it('gives up quickly rather than hanging the session start', () => {
    // A stalled camera must not block T0 indefinitely: the operator is
    // waiting, and the answer "no signal" is more useful than a spinner.
    expect(args).toContain('-timeout');
  });
});

describe('isNoSignal', () => {
  it('recognises the empty loopback message', () => {
    // Verbatim from this host with the puller stopped: v4l2loopback with
    // exclusive_caps reports the node as not a capture device until a writer
    // attaches. This is the exact case a recording must refuse.
    expect(
      isNoSignal('[video4linux2,v4l2 @ 0x1] Not a video capture device.\nError opening input: No such device'),
    ).toBe(true);
  });

  it('recognises a missing device', () => {
    expect(isNoSignal('Error opening input file /dev/video9.\nNo such file or directory')).toBe(true);
  });

  it('does not claim no-signal for an unrelated failure', () => {
    // A VAAPI or permission failure is a different problem with a different
    // fix, and reporting it as "no signal" would send the operator to restart
    // a phone app that was never the cause.
    expect(isNoSignal('Cannot initialise VAAPI device')).toBe(false);
    expect(isNoSignal('Permission denied')).toBe(false);
  });
});
