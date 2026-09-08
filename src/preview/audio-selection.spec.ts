import {
  audioObjectKey,
  missingAudioProxies,
  parseVolumedetect,
  selectAudioSource,
} from './audio-selection';

const level = (sourceRef: string, meanDb: number, maxDb: number) => ({ sourceRef, meanDb, maxDb });

describe('parseVolumedetect', () => {
  it('reads mean and max from ffmpeg volumedetect output', () => {
    const stderr = [
      '[Parsed_volumedetect_0 @ 0x1] mean_volume: -57.2 dB',
      '[Parsed_volumedetect_0 @ 0x1] max_volume: -20.3 dB',
    ].join('\n');
    expect(parseVolumedetect(stderr)).toEqual({ meanDb: -57.2, maxDb: -20.3 });
  });


  it('reads the instance that actually measured, not an empty one', () => {
    // Captured verbatim from a real run against a stored session: ffmpeg
    // instantiates volumedetect twice over a concat input, and the first
    // instance reports n_samples: 0 with no levels at all. Keying off the
    // first "volumedetect" line, or averaging the instances, would report a
    // measurement that never happened.
    const stderr = [
      '[Parsed_volumedetect_0 @ 0x5e6346369e40] n_samples: 0',
      '[Parsed_volumedetect_0 @ 0x5e6346409a00] n_samples: 87199744',
      '[Parsed_volumedetect_0 @ 0x5e6346409a00] mean_volume: -91.0 dB',
      '[Parsed_volumedetect_0 @ 0x5e6346409a00] max_volume: -91.0 dB',
      '[Parsed_volumedetect_0 @ 0x5e6346409a00] histogram_91db: 87199744',
    ].join('\n');
    expect(parseVolumedetect(stderr)).toEqual({ meanDb: -91, maxDb: -91 });
  });

  it('throws when neither field is present, rather than reporting digital silence', () => {
    // ffmpeg's volumedetect emits mean_volume and max_volume together on
    // success. If neither is present, the measurement failed -- it did not
    // observe silence -- and must not collapse into the -91 dB sentinel,
    // which would tell the operator a device was inactive when it was never
    // actually measured.
    expect(() => parseVolumedetect('ffmpeg: command not found')).toThrow();
  });

  it('falls back to the silence floor for only the field that is missing', () => {
    const stderr = '[Parsed_volumedetect_0 @ 0x1] mean_volume: -57.2 dB';
    expect(parseVolumedetect(stderr)).toEqual({ meanDb: -57.2, maxDb: -91 });
  });
});

describe('selectAudioSource', () => {
  it('selects the loudest source and says why', () => {
    const view = selectAudioSource([level('jabra', -91, -91), level('usb2', -57.2, -20.3)]);
    const chosen = view.find((v) => v.selected);
    expect(chosen?.sourceRef).toBe('usb2');
    expect(chosen?.reason).toBe('selected automatically: highest measured level');
  });

  it('labels a source at digital silence as such, not as merely quiet', () => {
    // -91.0 dB mean AND max is digital silence: it usually means the device
    // was not the active input. It does not mean the track is defective.
    const view = selectAudioSource([level('jabra', -91, -91), level('usb2', -57.2, -20.3)]);
    expect(view.find((v) => v.sourceRef === 'jabra')?.silent).toBe(true);
    expect(view.find((v) => v.sourceRef === 'usb2')?.silent).toBe(false);
  });

  it('honours a manual override and says the choice was the operator’s', () => {
    const view = selectAudioSource([level('jabra', -91, -91), level('usb2', -57.2, -20.3)], 'jabra');
    const chosen = view.find((v) => v.selected);
    expect(chosen?.sourceRef).toBe('jabra');
    expect(chosen?.reason).toBe('selected by the operator');
  });

  it('selects nothing when there are no audio sources', () => {
    expect(selectAudioSource([])).toEqual([]);
  });

  it('keeps every source in the view, including the silent ones', () => {
    // All sources are rendered and reachable; selection only decides which
    // one the console starts on. Dropping a silent source here would make it
    // unreachable, which is the failure this design exists to prevent.
    const view = selectAudioSource([
      level('jabra', -91, -91), level('usb1', -91, -91), level('usb2', -57.2, -20.3),
    ]);
    expect(view.map((v) => v.sourceRef).sort()).toEqual(['jabra', 'usb1', 'usb2']);
  });
});

describe('missingAudioProxies', () => {
  it('names the sources whose proxy was not rendered', () => {
    // Three sources with two proxies is an incomplete preview, and the
    // missing one is exactly the one the operator would have needed.
    const missing = missingAudioProxies(
      ['jabra', 'usb1', 'usb2'],
      ['p/preview/audio-jabra.m4a', 'p/preview/audio-usb2.m4a'],
      'p',
    );
    expect(missing).toEqual(['usb1']);
  });

  it('reports nothing missing for a complete set', () => {
    const missing = missingAudioProxies(
      ['jabra'], ['p/preview/audio-jabra.m4a'], 'p',
    );
    expect(missing).toEqual([]);
  });
});

describe('audioObjectKey with the real PipeWire refs of this host', () => {
  // Verbatim from the objects stored for session 7af04ef2. Two of the three
  // differ only in Audio_1 against Audio_2, so a slug that collapsed them
  // would have both sources write and read the SAME key: one microphone would
  // silently overwrite the other and the preview would look complete.
  const REAL = [
    'alsa_input.usb-Generic_USB_Audio-00.HiFi__hw_Audio_1__source',
    'alsa_input.usb-Generic_USB_Audio-00.HiFi__hw_Audio_2__source',
    'alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback',
  ];

  it('gives every real source a distinct key', () => {
    const keys = REAL.map((ref) => audioObjectKey('p', ref));
    expect(new Set(keys).size).toBe(REAL.length);
  });

  it('produces a key safe to carry in a URL path segment', () => {
    for (const ref of REAL) {
      const key = audioObjectKey('p', ref);
      expect(key).toMatch(/^p\/preview\/audio-[A-Za-z0-9_-]+\.m4a$/);
    }
  });
});

describe('audioObjectKey', () => {
  it('makes a filesystem-safe key from a PipeWire source name', () => {
    // Real source refs contain dots and hyphens, e.g.
    // alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback
    const key = audioObjectKey('sessions/2026/09/07/s1', 'alsa_input.usb-_Jabra_Link_390-00.mono-fallback');
    expect(key.startsWith('sessions/2026/09/07/s1/preview/audio-')).toBe(true);
    expect(key.endsWith('.m4a')).toBe(true);
    expect(key).not.toMatch(/\s/);
  });
});
