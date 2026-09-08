import { sourceSlug } from './source-slug';
import { sourceSlug as agentSourceSlug } from '../../agent/src/capture/session';

/**
 * The agent builds the S3 keys that are uploaded; the API builds the keys a
 * stored session is verified against. The agent is a separate TypeScript build
 * (`agent/tsconfig.json` sets `rootDir: ./src`) so it cannot import this
 * module, and the function is duplicated by necessity. These cases pin the two
 * copies together: divergence reports a complete upload as a session with
 * missing objects.
 */
describe('sourceSlug', () => {
  const cases: [string, string][] = [
    ['/dev/video9', 'dev-video9'],
    ['HDMI-A-0', 'HDMI-A-0'],
    ['alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback',
     'alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback'],
  ];

  it.each(cases)('flattens %s to one path segment', (input, expected) => {
    expect(sourceSlug(input)).toBe(expected);
    expect(sourceSlug(input)).not.toContain('/');
  });

  it.each(cases)('agrees with the agent copy for %s', (input) => {
    expect(agentSourceSlug(input)).toBe(sourceSlug(input));
  });

  it('leaves display and audio references untouched', () => {
    // These never contained a slash, which is why the webcam case was the one
    // that exposed the bug.
    expect(sourceSlug('HDMI-A-0')).toBe('HDMI-A-0');
  });
});
