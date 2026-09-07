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
