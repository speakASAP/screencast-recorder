import { S3Client } from '@aws-sdk/client-s3';
import { StorageService } from './storage.service';

/** Returns a fake S3 client whose paginated ListObjectsV2 yields these keys. */
const s3Listing = (contents: { Key: string; Size: number }[]) =>
  ({
    send: jest.fn().mockResolvedValue({ Contents: contents, IsTruncated: false }),
  }) as unknown as S3Client;

describe('StorageService.verifySession', () => {
  it('reports every missing object rather than only the first', async () => {
    // The operator needs the whole gap in one pass, not a one-at-a-time hunt.
    const svc = new StorageService(s3Listing([{ Key: 'p/a', Size: 10 }]), 'bucket');
    const result = await svc.verifySession('p', ['p/a', 'p/b', 'p/c']);
    expect(result.verified).toBe(false);
    expect(result.missing).toEqual(['p/b', 'p/c']);
  });

  it('treats a zero-byte object as missing', async () => {
    // A truncated upload leaves the key present with no bytes; presence alone
    // is not proof that the segment arrived.
    const svc = new StorageService(s3Listing([{ Key: 'p/a', Size: 0 }]), 'bucket');
    expect((await svc.verifySession('p', ['p/a'])).verified).toBe(false);
  });

  it('verifies when every expected object is present and non-empty', async () => {
    const svc = new StorageService(
      s3Listing([
        { Key: 'p/a', Size: 10 },
        { Key: 'p/b', Size: 20 },
      ]),
      'bucket',
    );
    const result = await svc.verifySession('p', ['p/a', 'p/b']);
    expect(result.verified).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('ignores extra objects under the prefix', async () => {
    // A stray file must not fail an otherwise complete session.
    const svc = new StorageService(
      s3Listing([
        { Key: 'p/a', Size: 10 },
        { Key: 'p/unexpected', Size: 5 },
      ]),
      'bucket',
    );
    expect((await svc.verifySession('p', ['p/a'])).verified).toBe(true);
  });

  it('fails verification when nothing was expected but nothing exists either', async () => {
    // An empty expectation list means the manifest was never ingested; calling
    // that "verified" would mark an empty session stored.
    const svc = new StorageService(s3Listing([]), 'bucket');
    expect((await svc.verifySession('p', [])).verified).toBe(false);
  });
});

describe('getObjectText', () => {
  it('returns null for a missing object rather than throwing', async () => {
    // "Absent" and "lookup failed" must stay distinguishable: a session with
    // no activity file is a valid answer, a broken bucket is not.
    const s3 = {
      send: jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { name: 'NoSuchKey' })),
    };
    const service = new StorageService(s3 as never, 'screencast-sessions');
    await expect(service.getObjectText('missing.jsonl')).resolves.toBeNull();
  });

  it('rethrows a real failure instead of reporting it as absent', async () => {
    const s3 = {
      send: jest.fn().mockRejectedValue(Object.assign(new Error('down'), { name: 'InternalError' })),
    };
    const service = new StorageService(s3 as never, 'screencast-sessions');
    await expect(service.getObjectText('events.jsonl')).rejects.toThrow('down');
  });

  it('returns the body of an object that exists', async () => {
    const s3 = {
      send: jest.fn().mockResolvedValue({
        Body: { transformToString: async () => '{"ts":1}\n' },
      }),
    };
    const service = new StorageService(s3 as never, 'screencast-sessions');
    await expect(service.getObjectText('events.jsonl')).resolves.toBe('{"ts":1}\n');
  });
});

describe('presignGet', () => {
  // A presigned URL is the storage boundary in string form: it hands a browser
  // direct read access to one private object. These assert the two properties
  // that keep that safe -- it is scoped to the one key asked for, and it
  // expires.
  // A real client with throwaway credentials: presigning is a local HMAC, so
  // this signs without any network call and exercises the actual signer.
  const presignerClient = () =>
    new S3Client({
      endpoint: 'https://minio.example',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    });

  it('signs a URL for exactly the requested key in the configured bucket', async () => {
    const service = new StorageService(presignerClient(), 'screencast-sessions');
    const url = await service.presignGet('sessions/2026/09/07/s1/preview/proxy.mp4', 300);
    expect(url).toContain('/screencast-sessions/sessions/2026/09/07/s1/preview/proxy.mp4');
    expect(url).toContain('X-Amz-Signature=');
  });

  it('carries the requested expiry, so a leaked URL stops working', async () => {
    const service = new StorageService(presignerClient(), 'screencast-sessions');
    const url = await service.presignGet('sessions/a/manifest.json', 300);
    expect(url).toContain('X-Amz-Expires=300');
  });
});
