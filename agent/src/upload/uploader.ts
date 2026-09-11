import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export interface S3Like {
  head(key: string): Promise<{ contentLength: number } | null>;
  put(key: string, path: string, bytes: number): Promise<void>;
  /** Keys under a prefix, sorted. Used by preview's storage fallback. */
  list(prefix: string): Promise<string[]>;
  /** Downloads one object to a local path. Used by preview's storage fallback. */
  get(key: string, toPath: string): Promise<void>;
  /** Deletes one object. Used only by the discard path in `purge.ts`. */
  remove(key: string): Promise<void>;
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
 * This class itself has no delete method: uploading and verifying a session
 * must never also be the thing that removes data. `S3Like.remove` exists for
 * one caller only -- `purge.ts`, invoked when the operator explicitly
 * discards a session -- and nothing in `Uploader` calls it. Local media is
 * untouched either way; that removal, if it ever happens, is a separate,
 * operator-gated action, not a side effect of a successful upload.
 */
export class Uploader {
  constructor(
    private readonly s3: S3Like,
    private readonly bucket: string,
    // `concurrency` is optional on the parameter type (rather than required,
    // as plain object defaults would suggest) so existing callers that only
    // ever cared about retries/backoff -- including tests written before this
    // option existed -- keep compiling and fall back to the same default of 3.
    private readonly options: { retries: number; backoffMs: number; concurrency?: number } = {
      retries: 5,
      backoffMs: 500,
      concurrency: 3,
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
   * Runs `worker` over `items` with at most `concurrency` in flight.
   *
   * Bounded rather than unbounded: a four-hour session is thousands of
   * segments, and `Promise.all` over all of them would open thousands of
   * sockets against MinIO at once.
   */
  private async pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const concurrency = this.options.concurrency ?? 3;
    const runners = Array.from({ length: Math.min(concurrency, queue.length) }, () =>
      (async () => {
        for (;;) {
          const item = queue.shift();
          if (item === undefined) return;
          await worker(item);
        }
      })(),
    );
    await Promise.all(runners);
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

    await this.pool(expected, async (object) => {
      const head = await this.s3.head(object.key).catch(() => null);
      if (!head || head.contentLength !== object.bytes) missing.push(object.key);
    });

    // Sorted so a missing-object report is stable regardless of which worker
    // happened to finish first.
    missing.sort();
    return { verified: missing.length === 0, missing };
  }

  /** Uploads every file, then verifies the whole set. */
  async uploadAll(files: { path: string; key: string; bytes: number }[]): Promise<UploadResult> {
    await this.pool(files, async (file) => {
      await this.uploadFile(file.path, file.key, file.bytes);
    });

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
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key) keys.push(object.Key);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys.sort();
    },
    async get(key, toPath) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      const body = response.Body as NodeJS.ReadableStream | undefined;
      if (!body) throw new Error(`object ${key} has no body`);
      await pipeline(body, createWriteStream(toPath));
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
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
