import {
  parseAudioInputs,
  parseDisplays,
  parseEncoders,
  pickScreenEncoder,
} from './capabilities';

describe('parseDisplays', () => {
  it('parses real xrandr --listmonitors output from this host', () => {
    // Verbatim from alfares. The `3840/600` form is width/physical-width-mm,
    // and reading the millimetres as pixels would produce a 600px capture.
    const out = 'Monitors: 1\n 0: +*HDMI-A-0 3840/600x2160/340+0+0  HDMI-A-0\n';
    expect(parseDisplays(out)).toEqual([
      { id: 'HDMI-A-0', width: 3840, height: 2160, x: 0, y: 0, primary: true },
    ]);
  });

  it('parses a second, non-primary monitor with an offset', () => {
    const out = [
      'Monitors: 2',
      ' 0: +*HDMI-A-0 3840/600x2160/340+0+0  HDMI-A-0',
      ' 1: +DP-1 1920/530x1080/300+3840+0  DP-1',
    ].join('\n');
    const displays = parseDisplays(out);
    expect(displays).toHaveLength(2);
    expect(displays[1]).toEqual({ id: 'DP-1', width: 1920, height: 1080, x: 3840, y: 0, primary: false });
  });

  it('returns an empty list rather than throwing when no monitor is attached', () => {
    expect(parseDisplays('Monitors: 0\n')).toEqual([]);
  });
});

describe('parseAudioInputs', () => {
  it('keeps real capture sources and drops monitors', () => {
    // Verbatim from alfares. A ".monitor" source is loopback of an output --
    // recording one captures playback, not the microphone.
    const out = [
      '51\talsa_output.usb-_Jabra_Link_390_6CFBEDCB8388-00.analog-stereo.monitor\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED',
      '52\talsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback\tPipeWire\ts16le 1ch 16000Hz\tSUSPENDED',
      '56\talsa_input.usb-Generic_USB_Audio-00.HiFi__hw_Audio_2__source\tPipeWire\ts24le 2ch 48000Hz\tIDLE',
    ].join('\n');

    const inputs = parseAudioInputs(out);
    expect(inputs.map((i) => i.id)).toEqual([
      'alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback',
      'alsa_input.usb-Generic_USB_Audio-00.HiFi__hw_Audio_2__source',
    ]);
  });

  it('gives a readable label rather than the raw PipeWire id', () => {
    const out =
      '52\talsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback\tPipeWire\ts16le 1ch 16000Hz\tSUSPENDED';
    // The operator picks from this list; the raw id is unreadable. The model
    // number stays -- it is how the device is recognised -- while the USB
    // serial and interface number go.
    expect(parseAudioInputs(out)[0].label).toBe('Jabra Link 390');
  });

  it('strips the ALSA hardware suffix from a generic device', () => {
    const out =
      '56\talsa_input.usb-Generic_USB_Audio-00.HiFi__hw_Audio_2__source\tPipeWire\ts24le 2ch 48000Hz\tIDLE';
    expect(parseAudioInputs(out)[0].label).toBe('Generic USB Audio');
  });

  it('reports the channel count', () => {
    const out =
      '52\talsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback\tPipeWire\ts16le 1ch 16000Hz\tSUSPENDED';
    expect(parseAudioInputs(out)[0].channels).toBe(1);
  });
});

describe('parseEncoders', () => {
  it('extracts encoder names from ffmpeg -encoders output', () => {
    const out = [
      ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
      ' V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)',
      ' V....D libx264              libx264 H.264 / AVC',
    ].join('\n');
    expect(parseEncoders(out)).toEqual(['h264_nvenc', 'h264_vaapi', 'libx264']);
  });
});

describe('pickScreenEncoder', () => {
  it('prefers VAAPI when the GPU supports it', () => {
    expect(pickScreenEncoder(['libx264', 'h264_vaapi'], { hasNvidia: false, hasVaapi: true })).toBe(
      'h264_vaapi',
    );
  });

  it('never picks NVENC on a machine with no NVIDIA device', () => {
    // ffmpeg lists h264_nvenc on this host, but the GPU is an AMD Navi 33.
    // Selecting it fails at runtime, minutes into a session, not at setup.
    expect(
      pickScreenEncoder(['h264_nvenc', 'libx264'], { hasNvidia: false, hasVaapi: false }),
    ).toBe('libx264');
  });

  it('falls back to software encoding when no hardware encoder is usable', () => {
    expect(pickScreenEncoder(['libx264'], { hasNvidia: false, hasVaapi: false })).toBe('libx264');
  });

  it('throws when not even libx264 is available, rather than returning undefined', () => {
    // A silent undefined would surface as a broken ffmpeg command line later.
    expect(() => pickScreenEncoder([], { hasNvidia: false, hasVaapi: false })).toThrow();
  });
});
