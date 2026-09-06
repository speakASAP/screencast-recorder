import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export interface S3Like {
  head(key: string): Promise<{ contentLength: number } | null>;
  put(key: string, path: string, bytes: number): Promise<void>;
}

export interface ExpectedObject {
  key: string;
  bytes: number;
}

export interface VerifyResult {
  verified: boolean;
  missing: string[];
}

export interface UploadResult {
  objects: number;
  bytes: number;
  verified: boolean;
  missing: string[];
}

/**
 * Uploads a finished session and reads every object back.
 *
 * There is deliberately no delete path anywhere in this class. Local media is
 * the only copy of something that cannot be re-recorded, and removing it is a
 * separate, operator-gated action that happens after a preview -- not a
 * side effect of a successful upload.
 */
export class Uploader {
  constructor(
    private readonly s3: S3Like,
    private readonly bucket: string,
    private readonly options: { retries: number; backoffMs: number } = {
      retries: 5,
      backoffMs: 500,
    },
  ) {}

  /**
   * Uploads one file, skipping it when the object is already present at the
   * expected size.
   *
   * The size check is what makes a resumed upload cheap: without it a
   * connection drop at hour three re-sends everything from the beginning.
   */
  async uploadFile(path: string, key: string, bytes: number): Promise<boolean> {
    const existing = await this.s3.head(key).catch(() => null);
    if (existing && existing.contentLength === bytes) return false;

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.retries; attempt += 1) {
      try {
        await this.s3.put(key, path, bytes);
        return true;
      } catch (error) {
        lastError = error;
        if (attempt < this.options.retries) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.options.backoffMs * 2 ** (attempt - 1)),
          );
        }
      }
    }

    throw new Error(
      `upload failed after ${this.options.retries} attempts: ${key}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /**
   * Independent readback of every object.
   *
   * Run after all uploads, as a separate pass: a PUT that returned success can
   * still have landed short, and the uploading process is the last thing that
   * should be trusted to audit itself.
   */
  async verify(expected: ExpectedObject[]): Promise<VerifyResult> {
    const missing: string[] = [];

    for (const object of expected) {
      const head = await this.s3.head(object.key).catch(() => null);
      if (!head || head.contentLength !== object.bytes) missing.push(object.key);
    }

    return { verified: missing.length === 0, missing };
  }

  /** Uploads every file, then verifies the whole set. */
  async uploadAll(files: { path: string; key: string; bytes: number }[]): Promise<UploadResult> {
    for (const file of files) {
      await this.uploadFile(file.path, file.key, file.bytes);
    }

    const result = await this.verify(files.map((f) => ({ key: f.key, bytes: f.bytes })));

    return {
      objects: files.length,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      verified: result.verified,
      missing: result.missing,
    };
  }
}

/** Real S3 client, scoped by the credentials the agent read from Vault. */
export function s3Client(config: {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}): S3Like {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: process.env.MINIO_REGION ?? 'us-east-1',
    // MinIO serves buckets as path segments, not subdomains.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async head(key) {
      try {
        const response = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return { contentLength: Number(response.ContentLength ?? 0) };
      } catch {
        return null;
      }
    },
    async put(key, path) {
      const { size } = await stat(path);
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: createReadStream(path),
          // Streaming a body requires an explicit length for SigV4.
          ContentLength: size,
        }),
      );
    },
  };
}
