import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreviewRenderer, readLevels, RendererDeps, slugSource } from './renderer';

const LEVELS = '[Parsed_volumedetect_0 @ 0x1] mean_volume: -57.2 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -20.3 dB';

async function makeRenderer(overrides: Partial<RendererDeps> = {}) {
  const workDir = await mkdtemp(join(tmpdir(), 'render-'));
  const deps: RendererDeps = {
    run: jest.fn(async () => LEVELS),
    // 8000 mono samples of half-scale tone: enough for a real bucket reduction.
    runBinary: jest.fn(async () => {
      const buffer = Buffer.alloc(8000 * 2);
      for (let i = 0; i < 8000; i += 1) buffer.writeInt16LE(16384, i * 2);
      return buffer;
    }),
    localSegments: jest.fn(async () => ['/rec/seg-00000.mp4']),
    fetchSegments: jest.fn(async () => ['/fetched/seg-00000.mp4']),
    upload: jest.fn(async () => 1234),
    durationMs: jest.fn(async () => 87837),
    workDir,
    ...overrides,
  };
  return { renderer: new PreviewRenderer(deps), deps };
}

describe('PreviewRenderer.render', () => {
  it('renders one audio proxy for every source, not only the loudest', async () => {
    // The owner uses different headsets across sessions, so which source
    // carried signal varies. Rendering one would strand the microphone that
    // actually captured the commentary, and would look like it worked.
    const { renderer } = await makeRenderer();
    const result = await renderer.render('s1', 'p', ['jabra', 'usb1', 'usb2'], 'screen-HDMI-A-0');

    expect(result.artifacts.filter((a) => a.kind === 'audio')).toHaveLength(3);
    expect(result.artifacts.filter((a) => a.kind === 'video')).toHaveLength(1);
    // Each source contributes its proxy and then its peaks file, in that
    // order, after the single video artifact.
    expect(result.artifacts.map((a) => `${a.kind}:${a.sourceRef}`)).toEqual([
      'video:null',
      'audio:jabra',
      'peaks:jabra',
      'audio:usb1',
      'peaks:usb1',
      'audio:usb2',
      'peaks:usb2',
    ]);
  });

  it('uploads a peaks file for every audio source', async () => {
    // Precomputed once at render time so the console draws a four-hour
    // session without downloading and decoding the audio in the browser.
    const { renderer } = await makeRenderer();
    const result = await renderer.render('s1', 'p', ['jabra', 'usb1'], 'screen-HDMI-A-0');

    const peaks = result.artifacts.filter((a) => a.kind === 'peaks');
    expect(peaks).toHaveLength(2);
    expect(peaks.map((a) => a.sourceRef)).toEqual(['jabra', 'usb1']);
    expect(peaks[0].objectKey).toMatch(/peaks-jabra\.json$/);
  });

  it('keeps a peaks file beside the proxy it describes', async () => {
    // Same slug, same prefix: the console pairs them by source without a
    // second lookup, and a mismatch would draw one source's waveform under
    // another's name.
    const { renderer } = await makeRenderer();
    const result = await renderer.render('s1', 'p', ['jabra'], 'screen-HDMI-A-0');
    const audio = result.artifacts.find((a) => a.kind === 'audio');
    const peaks = result.artifacts.find((a) => a.kind === 'peaks');
    expect(peaks!.objectKey.replace('peaks-', 'audio-').replace('.json', '.m4a')).toBe(
      audio!.objectKey,
    );
  });

  it('fails the whole render when one source has no segments', async () => {
    // A partial set must never reach the operator as ready: the missing
    // source is exactly the one they would have needed.
    const { renderer } = await makeRenderer({
      localSegments: jest.fn(async (_s: string, dir: string) =>
        dir === 'audio-usb1' ? [] : ['/rec/seg-00000.mp4'],
      ),
      fetchSegments: jest.fn(async () => []),
    });
    await expect(renderer.render('s1', 'p', ['jabra', 'usb1'], 'screen-HDMI-A-0')).rejects.toThrow(
      /usb1/,
    );
  });

  it('fails rather than rendering an empty proxy when the screen track is gone', async () => {
    const { renderer } = await makeRenderer({
      localSegments: jest.fn(async () => []),
      fetchSegments: jest.fn(async () => []),
    });
    await expect(renderer.render('s1', 'p', [], 'screen-HDMI-A-0')).rejects.toThrow(/no screen segments/);
  });

  it('reads from local media when it is present', async () => {
    const { renderer, deps } = await makeRenderer();
    const result = await renderer.render('s1', 'p', ['jabra'], 'screen-HDMI-A-0');
    expect(result.sourcePath).toBe('local');
    expect(deps.fetchSegments).not.toHaveBeenCalled();
  });

  it('falls back to storage when local media is gone', async () => {
    // Older sessions are exactly the ones whose contents are hardest to
    // recall, so preview must not fail precisely on them.
    const { renderer, deps } = await makeRenderer({ localSegments: jest.fn(async () => []) });
    const result = await renderer.render('s1', 'p', ['jabra'], 'screen-HDMI-A-0');
    expect(result.sourcePath).toBe('storage');
    expect(deps.fetchSegments).toHaveBeenCalled();
  });

  it('writes objects only under the session preview prefix', async () => {
    // The renderer must never write over session media. Every key it produces
    // is under preview/, and it has no delete path at all.
    const { renderer, deps } = await makeRenderer();
    await renderer.render('s1', 'sessions/2026/09/07/s1', ['jabra'], 'screen-HDMI-A-0');
    for (const call of (deps.upload as jest.Mock).mock.calls) {
      expect(call[1]).toMatch(/^sessions\/2026\/09\/07\/s1\/preview\//);
    }
  });

  it('carries each source’s measured level onto its artifact', async () => {
    const { renderer } = await makeRenderer();
    const result = await renderer.render('s1', 'p', ['jabra'], 'screen-HDMI-A-0');
    const audio = result.artifacts.find((a) => a.kind === 'audio');
    expect(audio).toMatchObject({ meanDb: -57.2, maxDb: -20.3 });
  });

  it('reports progress per output so a multi-source render does not look stalled', async () => {
    const messages: string[] = [];
    const { renderer } = await makeRenderer({ onProgress: (m: string) => messages.push(m) });
    await renderer.render('s1', 'p', ['jabra', 'usb2'], 'screen-HDMI-A-0');
    expect(messages).toEqual([
      'rendering the video proxy',
      'rendering audio for jabra',
      'extracting peaks for jabra',
      'rendering audio for usb2',
      'extracting peaks for usb2',
      'render complete',
    ]);
  });

  it('propagates an ffmpeg failure rather than reporting a proxy that was never written', async () => {
    const { renderer } = await makeRenderer({
      run: jest.fn(async () => {
        throw new Error('ffmpeg exited 1: no VAAPI device');
      }),
    });
    await expect(renderer.render('s1', 'p', [], 'screen-HDMI-A-0')).rejects.toThrow(/VAAPI/);
  });
});

describe('slugSource', () => {
  it('matches the API’s key slugging so both agree on the object key', () => {
    // A divergence here would have the agent write audio-x.m4a while the API
    // looks for audio-y.m4a, and the preview would report itself incomplete
    // with every file present.
    expect(slugSource('alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback')).toBe(
      'alsa_input_usb-_Jabra_Link_390_6CFBEDCB8388-00_mono-fallback',
    );
  });
});

describe('readLevels', () => {
  it('raises when volumedetect produced no levels at all', () => {
    // A failed measurement is not evidence of a quiet stream, and reporting
    // the silence floor would tell the operator a microphone was dead when
    // its level was never read.
    expect(() => readLevels('ffmpeg: command not found')).toThrow();
  });

  it('reads the instance that measured, not an empty one', () => {
    // Verbatim from a real run: ffmpeg instantiates volumedetect twice over a
    // concat input and the first reports n_samples: 0 with no levels.
    const stderr = [
      '[Parsed_volumedetect_0 @ 0xaaa] n_samples: 0',
      '[Parsed_volumedetect_0 @ 0xbbb] n_samples: 87199744',
      '[Parsed_volumedetect_0 @ 0xbbb] mean_volume: -91.0 dB',
      '[Parsed_volumedetect_0 @ 0xbbb] max_volume: -91.0 dB',
    ].join('\n');
    expect(readLevels(stderr)).toEqual({ meanDb: -91, maxDb: -91 });
  });
});
