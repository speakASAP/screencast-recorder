import { buildLivePreviewArgs, LOOPBACK_ONLY } from './preview-server';

describe('buildLivePreviewArgs', () => {
  const args = buildLivePreviewArgs('/dev/video9').join(' ');

  it('reads the loopback device the puller writes', () => {
    expect(args).toContain('-f v4l2');
    expect(args).toContain('-i /dev/video9');
  });

  it('emits multipart JPEG, which an <img> renders with no player', () => {
    // mpjpeg is the whole reason this is viable: the browser needs no HLS or
    // WebRTC machinery, just an <img> pointed at the endpoint.
    expect(args).toContain('-f mpjpeg');
    expect(args).toContain('pipe:1');
  });

  it('drops the frame rate and size, because this is a check not a recording', () => {
    // The preview only answers "is the camera alive and pointed at me". Full
    // 1080p30 would compete for USB/CPU with the recording that follows.
    expect(args).toContain('-r 10');
    expect(args).toContain('scale=640:-2');
  });
});

describe('preview server binding', () => {
  it('binds the loopback interface only', () => {
    // The stream is a live camera pointed at the operator. Binding 0.0.0.0
    // would publish it to every host on the LAN, with no authentication in
    // front of it, because the agent has none to offer.
    expect(LOOPBACK_ONLY).toBe('127.0.0.1');
  });
});
