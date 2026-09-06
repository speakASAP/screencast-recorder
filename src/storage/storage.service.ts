import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
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
