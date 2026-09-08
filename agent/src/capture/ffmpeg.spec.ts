import { buildAudioArgs, buildScreenArgs, buildWebcamArgs } from './ffmpeg';

const screenSpec = {
  display: ':0.0',
  width: 3840,
  height: 2160,
  fps: 15,
  codec: 'h264_vaapi',
  segmentSeconds: 60,
  outDir: '/tmp/session/screen-HDMI-A-0',
};

describe('buildScreenArgs', () => {
  it('segments output rather than writing one long file', () => {
    const args = buildScreenArgs(screenSpec).join(' ');
    // Segmentation caps crash loss at one segment and lets a later editing
    // stage drop whole intervals with -c copy, without re-encoding.
    expect(args).toContain('-f segment');
    expect(args).toContain('-segment_time 60');
  });

  it('zero-pads segment indices to five digits', () => {
    // Lexical order must equal chronological order: a four-hour session is
    // ~240 segments, and seg-9 sorting after seg-10 breaks concatenation.
    expect(buildScreenArgs(screenSpec).join(' ')).toContain('seg-%05d.mp4');
  });

  it('resets timestamps per segment so each file starts at zero', () => {
    // Without this every segment carries a global PTS and plays as a file that
    // begins hours in.
    expect(buildScreenArgs(screenSpec).join(' ')).toContain('-reset_timestamps 1');
  });

  it('initialises the VAAPI device and uploads frames to it', () => {
    const args = buildScreenArgs(screenSpec).join(' ');
    expect(args).toContain('-vaapi_device /dev/dri/renderD128');
    expect(args).toContain('hwupload');
  });

  it('captures the mouse cursor', () => {
    // A screencast without the pointer defeats the purpose: the viewer cannot
    // see what is being clicked.
    expect(buildScreenArgs(screenSpec).join(' ')).toContain('-draw_mouse 1');
  });

  it('records the requested frame rate and geometry', () => {
    const args = buildScreenArgs(screenSpec).join(' ');
    expect(args).toContain('-framerate 15');
    expect(args).toContain('-video_size 3840x2160');
  });

  it('uses software encoding without VAAPI flags when the codec is libx264', () => {
    // Passing -vaapi_device with a software encoder fails at start-up.
    const args = buildScreenArgs({ ...screenSpec, codec: 'libx264' }).join(' ');
    expect(args).toContain('libx264');
    expect(args).not.toContain('-vaapi_device');
    expect(args).not.toContain('hwupload');
  });

  it('offsets capture to the display position for a second monitor', () => {
    const args = buildScreenArgs({ ...screenSpec, x: 3840, y: 0 }).join(' ');
    // Without the offset every monitor records the primary one.
    expect(args).toContain(':0.0+3840,0');
  });
});

describe('buildAudioArgs', () => {
  const audioSpec = {
    source: 'alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback',
    codec: 'aac',
    bitrateKbps: 192,
    segmentSeconds: 60,
    outDir: '/tmp/session/audio-jabra',
  };

  it('writes audio as its own file, never muxed into the screen track', () => {
    // Separate tracks are what let an editor recombine them independently.
    const args = buildAudioArgs(audioSpec).join(' ');
    expect(args).toContain('-f pulse');
    expect(args).toContain('seg-%05d.m4a');
    expect(args).not.toContain('x11grab');
  });

  it('records from the named source rather than the default input', () => {
    expect(buildAudioArgs(audioSpec).join(' ')).toContain(audioSpec.source);
  });

  it('segments on the same boundary as video', () => {
    // Matching boundaries keep the two tracks trimmable at the same points.
    expect(buildAudioArgs(audioSpec).join(' ')).toContain('-segment_time 60');
  });
});

describe('buildWebcamArgs', () => {
  const webcamSpec = {
    device: '/dev/video9',
    width: 1280,
    height: 720,
    fps: 30,
    codec: 'h264_vaapi',
    segmentSeconds: 60,
    outDir: '/tmp/session/webcam-video9',
  };

  it('reads the named v4l2 device rather than the screen', () => {
    const args = buildWebcamArgs(webcamSpec).join(' ');
    expect(args).toContain('-f v4l2');
    expect(args).toContain('-i /dev/video9');
    expect(args).not.toContain('x11grab');
  });

  it('names no input format by default, letting ffmpeg negotiate', () => {
    // A v4l2loopback device fed by a phone stream offers exactly one format
    // (yuv420p on this host) and no MJPEG. Hardcoding -input_format mjpeg made
    // ffmpeg refuse the device outright:
    //   Cannot find a proper format for codec 'mjpeg' ... Invalid argument
    // Only a USB camera, which advertises several, needs to be told which.
    expect(buildWebcamArgs(webcamSpec)).not.toContain('-input_format');
  });

  it('requests an explicit input format before the input, not after', () => {
    // A UVC webcam advertises both raw YUYV and MJPEG, and raw 720p30 exceeds
    // USB 2.0 bandwidth, so the operator can pin MJPEG. It is an input option:
    // placed after -i it would apply to the output and be ignored.
    const args = buildWebcamArgs({ ...webcamSpec, inputFormat: 'mjpeg' });
    expect(args).toContain('mjpeg');
    expect(args.indexOf('-input_format')).toBeLessThan(args.indexOf('-i'));
  });

  it('segments on the same boundary as the screen and audio tracks', () => {
    // Matching boundaries are what let an editor trim every track at the same
    // points without re-encoding any of them.
    const args = buildWebcamArgs(webcamSpec).join(' ');
    expect(args).toContain('-f segment');
    expect(args).toContain('-segment_time 60');
    expect(args).toContain('-reset_timestamps 1');
    expect(args).toContain('seg-%05d.mp4');
  });

  it('initialises the VAAPI device and uploads frames to it', () => {
    const args = buildWebcamArgs(webcamSpec).join(' ');
    expect(args).toContain('-vaapi_device /dev/dri/renderD128');
    expect(args).toContain('hwupload');
  });

  it('uses software encoding without VAAPI flags when the codec is libx264', () => {
    // Passing -vaapi_device with a software encoder fails at start-up.
    const args = buildWebcamArgs({ ...webcamSpec, codec: 'libx264' }).join(' ');
    expect(args).toContain('libx264');
    expect(args).not.toContain('-vaapi_device');
    expect(args).not.toContain('hwupload');
  });

  it('records the requested frame rate and geometry', () => {
    const args = buildWebcamArgs(webcamSpec).join(' ');
    expect(args).toContain('-framerate 30');
    expect(args).toContain('-video_size 1280x720');
  });

  it('omits the geometry entirely when none is given', () => {
    // The API has no width/height to send: `tracks` carries no such columns and
    // the prepare payload is built from six fixed fields. Naming a guessed
    // 1280x720 would then downscale -- or fail outright -- against a camera
    // sending 1080p. Omitting -video_size makes ffmpeg take the device's own
    // format, which is correct for whatever the operator set on the phone.
    const { width, height, ...noGeometry } = webcamSpec;
    const args = buildWebcamArgs(noGeometry).join(' ');
    expect(args).not.toContain('-video_size');
    expect(args).toContain('-framerate 30');
  });

  it('carries no -draw_mouse, which v4l2 does not accept', () => {
    // Screen capture draws the pointer; a camera has none, and the flag is
    // rejected by the v4l2 demuxer.
    expect(buildWebcamArgs(webcamSpec).join(' ')).not.toContain('-draw_mouse');
  });
});
