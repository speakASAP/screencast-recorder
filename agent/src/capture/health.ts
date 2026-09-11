// agent/src/capture/health.ts

/**
 * Per-track capture health, derived from how many bytes arrive between ticks.
 *
 * `degraded` only ever flips when ffmpeg exits, so a process that stays alive
 * while capturing nothing reports healthy for the whole session. That is what
 * happened on 2026-09-10: one microphone wrote 914 KB in 21 minutes beside a
 * sibling that wrote 31 MB, and the console showed both as recording.
 */
export type TrackHealth = 'ok' | 'stalled' | 'quiet';

export interface HealthSample {
  trackId: string;
  kind: string;
  bytes: number;
}

export class HealthTracker {
  private readonly previous = new Map<string, number>();
  private readonly idleTicks = new Map<string, number>();
  private readonly stallTicks: number;
  private readonly quietBytesPerTick: number;

  constructor(options: { stallTicks?: number; quietBytesPerTick?: number } = {}) {
    this.stallTicks = options.stallTicks ?? 3;
    // Deliberately generous and deliberately advisory: the floor that separates
    // a muted device from a quiet room is not known yet, and must be tuned
    // against a real recording before it is given any more weight than a
    // warning.
    this.quietBytesPerTick = options.quietBytesPerTick ?? 2_000;
  }

  observe(samples: HealthSample[]): Map<string, TrackHealth> {
    const health = new Map<string, TrackHealth>();
    const deltas = new Map<string, number | null>();

    for (const sample of samples) {
      const before = this.previous.get(sample.trackId);
      deltas.set(sample.trackId, before === undefined ? null : sample.bytes - before);
      this.previous.set(sample.trackId, sample.bytes);
    }

    // A session where nothing advances is paused or ending. Flagging every
    // track then is noise, not a fault in any one of them.
    const anyAdvancing = [...deltas.values()].some((delta) => delta !== null && delta > 0);

    for (const sample of samples) {
      const delta = deltas.get(sample.trackId) ?? null;

      if (delta === null) {
        health.set(sample.trackId, 'ok');
        continue;
      }

      // events.jsonl is one growing file written in small bursts; the segment
      // stall rule does not describe it.
      if (sample.kind === 'metadata') {
        health.set(sample.trackId, 'ok');
        continue;
      }

      const idle = delta <= 0 && anyAdvancing ? (this.idleTicks.get(sample.trackId) ?? 0) + 1 : 0;
      this.idleTicks.set(sample.trackId, idle);

      if (idle >= this.stallTicks) {
        health.set(sample.trackId, 'stalled');
        continue;
      }

      if (sample.kind === 'audio' && delta > 0 && delta < this.quietBytesPerTick) {
        health.set(sample.trackId, 'quiet');
        continue;
      }

      health.set(sample.trackId, 'ok');
    }

    return health;
  }
}
