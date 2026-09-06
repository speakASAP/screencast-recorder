import { buildManifest, segmentTimeRanges } from './manifest';

describe('segmentTimeRanges', () => {
  it('derives ranges from actual durations, not from the nominal segment length', () => {
    // The last segment is short, and a dropped frame makes the others uneven.
    // An editor that assumed 60000 * index would drift further with every cut.
    const ranges = segmentTimeRanges([
      { file: 'seg-00000.mp4', durationMs: 60000, bytes: 1 },
      { file: 'seg-00001.mp4', durationMs: 59987, bytes: 1 },
      { file: 'seg-00002.mp4', durationMs: 12345, bytes: 1 },
    ]);

    expect(ranges[0]).toMatchObject({ index: 0, start_ms: 0, end_ms: 60000 });
    expect(ranges[1]).toMatchObject({ index: 1, start_ms: 60000, end_ms: 119987 });
    expect(ranges[2]).toMatchObject({ index: 2, start_ms: 119987, end_ms: 132332 });
  });

  it('produces contiguous ranges with no gap between segments', () => {
    const ranges = segmentTimeRanges([
      { file: 'a', durationMs: 1000, bytes: 1 },
      { file: 'b', durationMs: 1500, bytes: 1 },
      { file: 'c', durationMs: 700, bytes: 1 },
    ]);
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i].start_ms).toBe(ranges[i - 1].end_ms);
    }
  });

  it('handles an empty track without throwing', () => {
    expect(segmentTimeRanges([])).toEqual([]);
  });
});

describe('buildManifest', () => {
  const base = {
    agentId: '11111111-1111-1111-1111-111111111111',
    hostname: 'alfares',
    startedAt: new Date('2026-09-06T18:30:00Z'),
    endedAt: new Date('2026-09-06T18:32:12Z'),
    clockOffsetMs: 3,
  };

  it('records the measured clock offset', () => {
    // Without it, two machines' tracks cannot be aligned after the fact, and
    // the offset cannot be recovered from the media.
    const manifest = buildManifest({ ...base, tracks: [] });
    expect(manifest.clock_offset_ms).toBe(3);
  });

  it('orders segments lexically, matching chronological order', () => {
    const manifest = buildManifest({
      ...base,
      tracks: [
        {
          trackId: 't1',
          kind: 'screen',
          sourceRef: 'HDMI-A-0',
          codec: 'h264_vaapi',
          fps: 15,
          segments: [
            { file: 'seg-00010.mp4', durationMs: 1000, bytes: 10 },
            { file: 'seg-00002.mp4', durationMs: 1000, bytes: 10 },
          ],
        },
      ],
    });

    // Zero padding makes lexical order chronological; the writer must not
    // undo that by emitting them in discovery order.
    expect(manifest.tracks[0].segments.map((s) => s.file)).toEqual([
      'seg-00002.mp4',
      'seg-00010.mp4',
    ]);
  });

  it('carries the fields the API needs to derive expected object keys', () => {
    const manifest = buildManifest({
      ...base,
      tracks: [
        {
          trackId: 't1',
          kind: 'screen',
          sourceRef: 'HDMI-A-0',
          codec: 'h264_vaapi',
          fps: 15,
          segments: [{ file: 'seg-00000.mp4', durationMs: 1000, bytes: 10 }],
        },
      ],
    });

    // The API builds S3 keys as <prefix>/<hostname>/<kind>-<source_ref>/<file>,
    // so a missing hostname or source_ref makes verification look for the
    // wrong objects and refuse to store a complete session.
    expect(manifest.hostname).toBe('alfares');
    expect(manifest.tracks[0].source_ref).toBe('HDMI-A-0');
    expect(manifest.tracks[0].kind).toBe('screen');
    expect(manifest.agent_id).toBe(base.agentId);
  });

  it('emits ISO timestamps', () => {
    const manifest = buildManifest({ ...base, tracks: [] });
    expect(manifest.started_at).toBe('2026-09-06T18:30:00.000Z');
    expect(manifest.ended_at).toBe('2026-09-06T18:32:12.000Z');
  });

  it('sums segment bytes per track', () => {
    const manifest = buildManifest({
      ...base,
      tracks: [
        {
          trackId: 't1',
          kind: 'screen',
          sourceRef: 'HDMI-A-0',
          codec: 'h264_vaapi',
          fps: 15,
          segments: [
            { file: 'seg-00000.mp4', durationMs: 1000, bytes: 100 },
            { file: 'seg-00001.mp4', durationMs: 1000, bytes: 250 },
          ],
        },
      ],
    });
    expect(manifest.tracks[0].segments.reduce((n, s) => n + s.bytes, 0)).toBe(350);
  });
});
