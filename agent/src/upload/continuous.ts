import { basename } from 'node:path';
// Imported, never redeclared: Task 3 exports this from the module that builds
// the directories. Two copies of the same interface drift the moment one side
// gains a field.
import type { LiveTrackDir } from '../capture/session';
import { closedSegments } from './eligibility';

export interface ContinuousDeps {
  listDir(dir: string): Promise<string[]>;
  sizeOf(path: string): Promise<number>;
  upload(path: string, key: string, bytes: number): Promise<void>;
}

export interface UploadHealth {
  queued: number;
  failures: number;
  oldestPendingMs: number | null;
}

/**
 * Uploads closed segments while the recording is still running.
 *
 * The controlling rule is that nothing here may affect capture. Every failure
 * is swallowed and retried on a later sweep: local media is the durable copy
 * and S3 is the backup, so a storage outage must leave ffmpeg untouched. What
 * the operator gets instead of a halt is `health()`, which the console renders
 * as an alarm.
 */
export class ContinuousUploader {
  private readonly done = new Set<string>();
  private readonly firstSeen = new Map<string, number>();
  private failures = 0;

  constructor(
    private readonly deps: ContinuousDeps,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async sweep(tracks: LiveTrackDir[], prefix: string, hostname: string): Promise<void> {
    for (const track of tracks) {
      let names: string[];
      try {
        names = await this.deps.listDir(track.dir);
      } catch {
        // No directory yet, or it vanished. Nothing to do this sweep.
        continue;
      }

      const folder = basename(track.dir);
      for (const name of closedSegments(names)) {
        const path = `${track.dir}/${name}`;
        const key = `${prefix}/${hostname}/${folder}/${name}`;
        if (this.done.has(key)) continue;

        if (!this.firstSeen.has(key)) this.firstSeen.set(key, this.now());

        try {
          const bytes = await this.deps.sizeOf(path);
          await this.deps.upload(path, key, bytes);
          this.done.add(key);
          this.firstSeen.delete(key);
        } catch {
          // Retried on the next sweep. Never rethrown: this runs inside the
          // agent's tick, and capture must outlive any storage problem.
          this.failures += 1;
        }
      }
    }
  }

  health(): UploadHealth {
    const pending = [...this.firstSeen.values()];
    const oldest = pending.length > 0 ? Math.min(...pending) : null;

    return {
      queued: pending.length,
      failures: this.failures,
      oldestPendingMs: oldest === null ? null : this.now() - oldest,
    };
  }
}
