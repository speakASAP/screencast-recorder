/** A queued report that could not be delivered while the API was unreachable. */
export interface PendingReport {
  path: string;
  body: unknown;
}

export interface PendingStoreDeps {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
}

/**
 * Persists undelivered reports so they survive the agent process.
 *
 * On 2026-09-10 an upload finished, its `upload-complete` call failed, and the
 * failure report that would have explained it was pushed onto an in-memory
 * array and lost with the process. The session sat in `uploading` with an empty
 * failure reason and no record anywhere of what went wrong.
 *
 * Every method swallows its own I/O errors. A queue that cannot be written is a
 * degraded audit trail; an exception here would reach the tick loop.
 */
export class PendingStore {
  constructor(private readonly deps: PendingStoreDeps) {}

  async load(): Promise<PendingReport[]> {
    let raw: string | null;
    try {
      raw = await this.deps.read();
    } catch {
      return [];
    }
    if (!raw) return [];

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as PendingReport[];
    } catch {
      // A crash mid-write leaves a partial file. Starting with an empty queue
      // beats refusing to start.
      return [];
    }
  }

  async save(reports: PendingReport[]): Promise<void> {
    try {
      await this.deps.write(JSON.stringify(reports));
    } catch {
      // Nothing to do and nowhere to report it. Never rethrow: this is called
      // from the report path, which is called from the tick loop.
    }
  }
}
