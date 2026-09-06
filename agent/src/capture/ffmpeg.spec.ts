import { buildAudioArgs, buildScreenArgs } from './ffmpeg';

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
