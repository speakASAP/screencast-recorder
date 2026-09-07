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
