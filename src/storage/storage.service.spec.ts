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
