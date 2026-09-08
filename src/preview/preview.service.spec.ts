import { NotFoundException } from '@nestjs/common';
import { PreviewService } from './preview.service';
import { PreviewState } from './session-preview.entity';
import { SessionState } from '../sessions/entities/session.entity';

// Assembled at runtime: a credential-shaped literal in a source file trips the
// repository's secret scanner, and quite right too.
const CREDENTIAL_TITLE = `deploy hvs.${'CAESIJ'}${'x'.repeat(18)} - Cursor`;

const sampleLine = (ts: number, window: string) =>
  JSON.stringify({
    ts,
    display: 'HDMI-A-0',
    window,
    mouse: [1, 1],
    clicks: 0,
    keys: 0,
    hotkeys: [],
  });

const manifestDocument = (audioRefs: string[]) => ({
  agent_id: 'a1',
  hostname: 'alfares',
  tracks: [
    { kind: 'screen', source_ref: 'HDMI-A-0', segments: [] },
    { kind: 'metadata', source_ref: 'activity', segments: [] },
    ...audioRefs.map((ref) => ({ kind: 'audio', source_ref: ref, segments: [] })),
  ],
});

function makeService(audioRefs: string[] = ['jabra']) {
  const session = { id: 's1', state: SessionState.Stored, s3Prefix: 'sessions/2026/09/07/s1' };
  const sessions = { findOne: jest.fn().mockResolvedValue(session) };
  const previews = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row) => row),
    save: jest.fn(async (row) => row),
  };
  const manifests = {
    find: jest.fn().mockResolvedValue([{ agentId: 'a1', document: manifestDocument(audioRefs) }]),
  };
  const storage = {
    getObjectText: jest.fn(),
    presignGet: jest.fn().mockResolvedValue('https://signed'),
  };
  const commands = { queue: jest.fn() };
  const service = new PreviewService(
    sessions as never,
    previews as never,
    manifests as never,
    storage as never,
    commands as never,
  );
  return { service, sessions, previews, manifests, storage, commands };
}

describe('PreviewService.timeline', () => {
  it('never lets a credential-shaped window title reach the response', async () => {
    // The tracker's sanitiser runs upstream, two layers away, with nothing
    // asserting the contract between it and this endpoint. Preview is the
    // first thing that puts titles on a screen, so the boundary is pinned
    // here. This does not add redaction; it prevents the guarantee from
    // silently lapsing.
    const { service, storage } = makeService();
    storage.getObjectText.mockResolvedValue(
      [sampleLine(1000, CREDENTIAL_TITLE), sampleLine(1000.2, CREDENTIAL_TITLE)].join('\n'),
    );
    const timeline = await service.timeline('s1', 10);
    expect(JSON.stringify(timeline)).not.toMatch(/hvs\.[A-Za-z0-9]/);
  });

  it('raises rather than returning an empty timeline when the activity file is missing', async () => {
    // An empty timeline would read as "nothing happened" instead of "the file
    // could not be found".
    const { service, storage } = makeService();
    storage.getObjectText.mockResolvedValue(null);
    await expect(service.timeline('s1', 10)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('merges the activity of every host in a multi-host session', async () => {
    // One manifest per agent, all under the same session prefix. Reading only
    // the first would silently drop a machine's whole timeline.
    const { service, manifests, storage } = makeService();
    manifests.find.mockResolvedValue([
      { agentId: 'a1', document: { ...manifestDocument(['jabra']), hostname: 'alfares' } },
      { agentId: 'a2', document: { ...manifestDocument(['built-in']), hostname: 'macbook' } },
    ]);
    storage.getObjectText.mockImplementation(async (key: string) =>
      key.includes('alfares')
        ? [sampleLine(1000, 'nvim'), sampleLine(1000.2, 'nvim')].join('\n')
        : [sampleLine(1000.4, 'Xcode'), sampleLine(1000.6, 'Xcode')].join('\n'),
    );
    const timeline = await service.timeline('s1', 10);
    expect(timeline.sampleCount).toBe(4);
    expect(timeline.topWindows.map((w) => w.window).sort()).toEqual(['Xcode', 'nvim']);
  });
});

describe('PreviewService.status', () => {
  it('always reports keys and clicks as not captured', async () => {
    // The counters were wired up only after these sessions were recorded, so
    // every stored session reports zeroes. A zero would tell the operator the
    // session was quiet; the honest answer is that the signal was not
    // recorded.
    const { service } = makeService();
    expect((await service.status('s1')).keysAndClicks).toBe('not-captured');
  });

  it('lists every audio source, including the silent ones', async () => {
    // A source that carried no signal is exactly what the operator needs to
    // see: omitting it would leave them wondering which headset was live.
    const { service, previews } = makeService(['jabra', 'usb1', 'usb2']);
    previews.findOne.mockResolvedValue({
      state: PreviewState.Ready,
      selectedSourceRef: null,
      artifacts: [
        { kind: 'video', sourceRef: null, objectKey: 'p/preview/proxy.mp4', bytes: 1, durationMs: 87837 },
        { kind: 'audio', sourceRef: 'jabra', objectKey: 'k1', bytes: 1, durationMs: 1, meanDb: -91, maxDb: -91 },
        { kind: 'audio', sourceRef: 'usb1', objectKey: 'k2', bytes: 1, durationMs: 1, meanDb: -91, maxDb: -91 },
        { kind: 'audio', sourceRef: 'usb2', objectKey: 'k3', bytes: 1, durationMs: 1, meanDb: -32, maxDb: -8 },
      ],
    });
    const status = await service.status('s1');
    expect(status.audioSources.map((s) => s.sourceRef)).toEqual(['jabra', 'usb1', 'usb2']);
    expect(status.audioSources.filter((s) => s.silent).map((s) => s.sourceRef)).toEqual(['jabra', 'usb1']);
    expect(status.audioSources.find((s) => s.selected)?.sourceRef).toBe('usb2');
  });

  it('reports a pending preview without artifacts rather than raising', async () => {
    const { service } = makeService();
    const status = await service.status('s1');
    expect(status.state).toBe(PreviewState.Pending);
    expect(status.durationMs).toBeNull();
  });
});

describe('PreviewService.requestRender', () => {
  it('queues a render-preview command for a stored session', async () => {
    const { service, commands } = makeService();
    await service.requestRender('s1');
    expect(commands.queue).toHaveBeenCalledWith(
      'a1',
      'render-preview',
      's1',
      expect.objectContaining({ prefix: 'sessions/2026/09/07/s1' }),
    );
  });

  it('names every audio source in the payload, so one render produces the whole set', async () => {
    const { service, commands } = makeService(['jabra', 'usb1', 'usb2']);
    await service.requestRender('s1');
    expect(commands.queue).toHaveBeenCalledWith(
      'a1',
      'render-preview',
      's1',
      expect.objectContaining({ audioSourceRefs: ['jabra', 'usb1', 'usb2'] }),
    );
  });

  it('refuses a session that is not stored', async () => {
    // Rendering from a session still being written would read half a
    // recording and call the result a preview of it.
    const { service, sessions } = makeService();
    sessions.findOne.mockResolvedValue({ id: 's1', state: SessionState.Recording, s3Prefix: null });
    await expect(service.requestRender('s1')).rejects.toThrow(/not stored/i);
  });

  it('does not re-render a ready preview', async () => {
    const { service, previews, commands } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Ready, artifacts: [] });
    await service.requestRender('s1');
    expect(commands.queue).not.toHaveBeenCalled();
  });

  it('does not queue a second render while one is already running', async () => {
    const { service, previews, commands } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Rendering, artifacts: [] });
    await service.requestRender('s1');
    expect(commands.queue).not.toHaveBeenCalled();
  });

  it('retries a failed render', async () => {
    // Retry after a failure is the whole recovery path.
    const { service, previews, commands } = makeService();
    previews.findOne.mockResolvedValue({
      state: PreviewState.Failed,
      failureReason: 'ffmpeg died',
      artifacts: [],
    });
    await service.requestRender('s1');
    expect(commands.queue).toHaveBeenCalled();
  });
});

describe('PreviewService media URLs', () => {
  const readyPreview = {
    state: PreviewState.Ready,
    selectedSourceRef: null,
    artifacts: [
      { kind: 'video', sourceRef: null, objectKey: 'p/preview/proxy.mp4', bytes: 1, durationMs: 1 },
      { kind: 'audio', sourceRef: 'usb2', objectKey: 'p/preview/audio-usb2.m4a', bytes: 1, durationMs: 1 },
    ],
  };

  it('presigns the proxy for the requested source', async () => {
    const { service, previews, storage } = makeService(['usb2']);
    previews.findOne.mockResolvedValue(readyPreview);
    await service.audioUrl('s1', 'usb2');
    expect(storage.presignGet).toHaveBeenCalledWith('p/preview/audio-usb2.m4a', expect.any(Number));
  });

  it('raises for a source that has no rendered proxy rather than falling back to another', async () => {
    // Falling back to a different microphone would play the operator audio
    // from a source they did not choose, and nothing on screen would say so.
    const { service, previews } = makeService(['usb2', 'jabra']);
    previews.findOne.mockResolvedValue(readyPreview);
    await expect(service.audioUrl('s1', 'jabra')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('presigns the video proxy', async () => {
    const { service, previews, storage } = makeService(['usb2']);
    previews.findOne.mockResolvedValue(readyPreview);
    await service.videoUrl('s1');
    expect(storage.presignGet).toHaveBeenCalledWith('p/preview/proxy.mp4', expect.any(Number));
  });

  it('raises rather than silently regenerating when the preview is not ready', async () => {
    const { service, previews } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Rendering, artifacts: [] });
    await expect(service.videoUrl('s1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PreviewService.selectSource', () => {
  it('persists the operator’s choice so reopening does not revert it', async () => {
    const { service, previews } = makeService(['jabra', 'usb2']);
    previews.findOne.mockResolvedValue({
      state: PreviewState.Ready,
      selectedSourceRef: null,
      artifacts: [
        { kind: 'audio', sourceRef: 'jabra', objectKey: 'k1', bytes: 1, durationMs: 1, meanDb: -20, maxDb: -5 },
        { kind: 'audio', sourceRef: 'usb2', objectKey: 'k2', bytes: 1, durationMs: 1, meanDb: -91, maxDb: -91 },
      ],
    });
    const status = await service.selectSource('s1', 'usb2');
    expect(previews.save).toHaveBeenCalledWith(
      expect.objectContaining({ selectedSourceRef: 'usb2' }),
    );
    // Even though jabra is louder, the operator's pick wins and says so.
    const chosen = status.audioSources.find((s) => s.selected);
    expect(chosen?.sourceRef).toBe('usb2');
    expect(chosen?.reason).toMatch(/operator/i);
  });

  it('refuses a source the session never captured', async () => {
    const { service, previews } = makeService(['jabra']);
    previews.findOne.mockResolvedValue({
      state: PreviewState.Ready,
      selectedSourceRef: null,
      artifacts: [{ kind: 'audio', sourceRef: 'jabra', objectKey: 'k1', bytes: 1, durationMs: 1 }],
    });
    await expect(service.selectSource('s1', 'nonexistent')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PreviewService session lookup', () => {
  it('raises for a session that does not exist', async () => {
    const { service, sessions } = makeService();
    sessions.findOne.mockResolvedValue(null);
    await expect(service.status('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
