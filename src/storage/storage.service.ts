import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger } from '@nestjs/common';

export const S3_CLIENT = 'S3_CLIENT';
export const S3_BUCKET = 'S3_BUCKET';

export interface VerificationResult {
  verified: boolean;
  missing: string[];
  found: number;
}

/**
 * Read-only view of the session bucket.
 *
 * The API never uploads and never deletes: agents write to MinIO directly with
 * their own scoped credential, and deletion is a separate operator-gated
 * action. Keeping this service read-only means the API's credential needs
 * nothing beyond ListBucket.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(S3_BUCKET) private readonly bucket: string,
  ) {}

  /**
   * Confirms every expected key exists under the prefix with a non-zero size.
   *
   * This is the only evidence accepted for marking a session stored. An
   * agent's own "upload succeeded" claim is not evidence: it cannot see a
   * truncated PUT that left a zero-byte key behind.
   */
  async verifySession(prefix: string, expectedKeys: string[]): Promise<VerificationResult> {
    // An empty expectation list means no manifest was ingested. Reporting that
    // as verified would mark an empty session stored.
    if (expectedKeys.length === 0) {
      return { verified: false, missing: [], found: 0 };
    }

    const sizes = await this.listSizes(prefix);
    const missing = expectedKeys.filter((key) => {
      const size = sizes.get(key);
      return size === undefined || size <= 0;
    });

    if (missing.length > 0) {
      this.logger.warn(
        `Session at ${prefix} is missing ${missing.length} of ${expectedKeys.length} objects`,
      );
    }

    return { verified: missing.length === 0, missing, found: sizes.size };
  }

  /**
   * Short-lived presigned GET so the browser fetches media directly.
   *
   * The API must not become the data path for video, exactly as it is not the
   * data path for upload. Presigning spends the `s3:GetObject` the scoped
   * credential already holds and needs no new permission and no public bucket
   * policy; the expiry is what keeps a copied URL from outliving the page it
   * was rendered on.
   */
  async presignGet(key: string, expirySeconds: number): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expirySeconds,
    });
  }

  /**
   * Reads a small text object whole. Used for events.jsonl, which runs to
   * roughly 10 MB over four hours -- fine to parse in the pod, unlike video,
   * which never passes through here.
   */
  async getObjectText(key: string): Promise<string | null> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return (await response.Body?.transformToString()) ?? null;
    } catch (error) {
      const name = (error as { name?: string }).name;
      // Absent is an answer -- a session may legitimately have no activity
      // file. Anything else is a failure and must surface rather than be
      // reported as an empty timeline.
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw error;
    }
  }

  private async listSizes(prefix: string): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    let token: string | undefined;

    // A four-hour session runs to thousands of segments, well past the 1000-key
    // page limit, so paginating is required rather than defensive.
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) sizes.set(object.Key, object.Size ?? 0);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    return sizes;
  }
}
