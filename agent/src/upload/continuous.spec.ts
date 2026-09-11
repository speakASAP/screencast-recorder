import { ContinuousUploader, ContinuousDeps } from './continuous';

function makeDeps(overrides: Partial<ContinuousDeps> = {}): ContinuousDeps & { uploaded: string[] } {
  const uploaded: string[] = [];
  return {
    uploaded,
    listDir: jest.fn(async () => ['seg-00000.mp4', 'seg-00001.mp4', 'seg-00002.mp4']),
    sizeOf: jest.fn(async () => 100),
    upload: jest.fn(async (_path: string, key: string) => {
      uploaded.push(key);
    }),
    ...overrides,
  } as ContinuousDeps & { uploaded: string[] };
}

const track = { trackId: 't1', kind: 'screen', dir: '/rec/s1/alfares/screen-HDMI-A-0' };

describe('ContinuousUploader.sweep', () => {
  it('uploads closed segments to the key layout the API verifies', async () => {
    // <prefix>/<hostname>/<kind>-<source_ref>/<file>. The local directory name
    // is already that shape, so the key is the prefix plus the tail.
    const deps = makeDeps();
    const uploader = new ContinuousUploader(deps);

    await uploader.sweep([track], 'sessions/2026/09/11/s1', 'alfares');

    expect(deps.uploaded).toEqual([
      'sessions/2026/09/11/s1/alfares/screen-HDMI-A-0/seg-00000.mp4',
      'sessions/2026/09/11/s1/alfares/screen-HDMI-A-0/seg-00001.mp4',
    ]);
  });

  it('never uploads the segment ffmpeg is still writing', async () => {
    const deps = makeDeps();
    const uploader = new ContinuousUploader(deps);

    await uploader.sweep([track], 'p', 'alfares');

    expect(deps.uploaded.some((key) => key.endsWith('seg-00002.mp4'))).toBe(false);
  });

  it('does not re-upload a segment it already sent', async () => {
    // Every tick re-lists the directory. Without this the same segment is sent
    // every five seconds for the rest of the session.
    const deps = makeDeps();
    const uploader = new ContinuousUploader(deps);

    await uploader.sweep([track], 'p', 'alfares');
    await uploader.sweep([track], 'p', 'alfares');

    expect(deps.uploaded).toHaveLength(2);
  });

  it('keeps capture alive when an upload throws', async () => {
    // The controlling rule: an S3 problem must never reach ffmpeg.
    const deps = makeDeps({
      upload: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    });
    const uploader = new ContinuousUploader(deps);

    await expect(uploader.sweep([track], 'p', 'alfares')).resolves.toBeUndefined();
  });

  it('retries a failed segment on the next sweep', async () => {
    let fail = true;
    const uploaded: string[] = [];
    const deps = makeDeps({
      upload: jest.fn(async (_path: string, key: string) => {
        if (fail) throw new Error('connection reset');
        uploaded.push(key);
      }),
    });
    const uploader = new ContinuousUploader(deps);

    await uploader.sweep([track], 'p', 'alfares');
    fail = false;
    await uploader.sweep([track], 'p', 'alfares');

    expect(uploaded).toHaveLength(2);
  });

  it('reports health so the console can alarm on a failing upload', async () => {
    const deps = makeDeps({
      upload: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    });
    let clock = 1000;
    const uploader = new ContinuousUploader(deps, () => clock);

    await uploader.sweep([track], 'p', 'alfares');
    clock = 61000;

    const health = uploader.health();
    expect(health.failures).toBeGreaterThan(0);
    expect(health.queued).toBe(2);
    expect(health.oldestPendingMs).toBe(60000);
  });

  it('is clean when everything has been uploaded', async () => {
    const deps = makeDeps();
    const uploader = new ContinuousUploader(deps);

    await uploader.sweep([track], 'p', 'alfares');

    expect(uploader.health()).toEqual({ queued: 0, failures: 0, oldestPendingMs: null });
  });

  it('skips a directory that does not exist yet', async () => {
    // A track whose first segment has not closed has no directory listing.
    const deps = makeDeps({
      listDir: jest.fn(async () => {
        throw new Error('ENOENT');
      }),
    });
    const uploader = new ContinuousUploader(deps);

    await expect(uploader.sweep([track], 'p', 'alfares')).resolves.toBeUndefined();
  });
});
