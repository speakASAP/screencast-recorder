import { Uploader, S3Like } from './uploader';

function fakeS3(overrides: Partial<S3Like> = {}): S3Like & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    head: jest.fn(async () => ({ contentLength: 0 })),
    put: jest.fn(async (key: string) => {
      puts.push(key);
    }),
    ...overrides,
  } as S3Like & { puts: string[] };
}

describe('Uploader.uploadFile', () => {
  it('skips an object already present at the right size', async () => {
    // A resumed upload must not re-send tens of gigabytes it already sent.
    const s3 = fakeS3({ head: jest.fn(async () => ({ contentLength: 100 })) });
    const uploader = new Uploader(s3, 'bucket');

    await uploader.uploadFile('/local/a', 'p/a', 100);
    expect(s3.put).not.toHaveBeenCalled();
  });

  it('re-uploads when the remote size differs', async () => {
    // A truncated PUT leaves a short object; trusting its presence would ship a
    // corrupt segment.
    const s3 = fakeS3({ head: jest.fn(async () => ({ contentLength: 40 })) });
    const uploader = new Uploader(s3, 'bucket');

    await uploader.uploadFile('/local/a', 'p/a', 100);
    expect(s3.put).toHaveBeenCalled();
  });

  it('uploads when the object is absent', async () => {
    const s3 = fakeS3({ head: jest.fn(async () => null) });
    const uploader = new Uploader(s3, 'bucket');

    await uploader.uploadFile('/local/a', 'p/a', 100);
    expect(s3.put).toHaveBeenCalled();
  });

  it('retries a failing upload before giving up', async () => {
    const put = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(undefined);
    const s3 = fakeS3({ head: jest.fn(async () => null), put });
    const uploader = new Uploader(s3, 'bucket', { retries: 3, backoffMs: 1 });

    await uploader.uploadFile('/local/a', 'p/a', 100);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries rather than reporting success', async () => {
    const s3 = fakeS3({
      head: jest.fn(async () => null),
      put: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    });
    const uploader = new Uploader(s3, 'bucket', { retries: 2, backoffMs: 1 });

    await expect(uploader.uploadFile('/local/a', 'p/a', 100)).rejects.toThrow();
  });
});

describe('Uploader.verify', () => {
  it('reports verified only when every object reads back at full size', async () => {
    // Verification is an independent readback, not the absence of an upload
    // error: the uploader cannot see a PUT the server truncated.
    const s3 = fakeS3({ head: jest.fn(async () => ({ contentLength: 10 })) });
    const uploader = new Uploader(s3, 'bucket');

    const result = await uploader.verify([
      { key: 'p/a', bytes: 10 },
      { key: 'p/b', bytes: 10 },
    ]);
    expect(result.verified).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('names every object that failed readback, not just the first', async () => {
    const s3 = fakeS3({
      head: jest.fn(async (key: string) => (key === 'p/a' ? { contentLength: 10 } : null)),
    });
    const uploader = new Uploader(s3, 'bucket');

    const result = await uploader.verify([
      { key: 'p/a', bytes: 10 },
      { key: 'p/b', bytes: 10 },
      { key: 'p/c', bytes: 10 },
    ]);
    expect(result.verified).toBe(false);
    expect(result.missing).toEqual(['p/b', 'p/c']);
  });

  it('treats a short object as failed verification', async () => {
    const s3 = fakeS3({ head: jest.fn(async () => ({ contentLength: 5 })) });
    const uploader = new Uploader(s3, 'bucket');

    expect((await uploader.verify([{ key: 'p/a', bytes: 10 }])).verified).toBe(false);
  });
});

describe('what the uploader must never do', () => {
  it('exposes no method that deletes anything', () => {
    // Deletion is a separate operator-gated action. An unrepeatable four-hour
    // recording must not be removable by the component that uploads it.
    const uploader = new Uploader(fakeS3(), 'bucket') as unknown as Record<string, unknown>;
    const names = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(uploader)),
      ...Object.keys(uploader),
    ];
    expect(names.filter((n) => /delete|remove|rm|purge|unlink/i.test(n))).toEqual([]);
  });
});
