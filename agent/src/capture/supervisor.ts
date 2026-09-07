import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type SpawnFn = (command: string, args: string[]) => ChildProcess;

export interface TrackSpec {
  trackId: string;
  kind: string;
  args: string[];
  outDir: string;
}

export interface TrackState {
  trackId: string;
  kind: string;
  running: boolean;
  degraded: boolean;
  exitCode: number | null;
  lastError: string | null;
  /** Segments finished on disk, and their total size. */
  segments: number;
  bytes: number;
}

interface Entry {
  spec: TrackSpec;
  proc: ChildProcess;
  state: TrackState;
  stderrTail: string;
}

/**
 * Runs one ffmpeg process per track and keeps the session alive when one dies.
 *
 * The failure model is deliberate: losing the microphone should not throw away
 * three hours of screen capture, so a dead process marks its own track degraded
 * and everything else keeps recording.
 */
export class CaptureSupervisor {
  private readonly entries = new Map<string, Entry>();
  private stopping = false;

  constructor(
    private readonly spawnFn: SpawnFn = (command, args) =>
      nodeSpawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }),
    private readonly options: { graceMs: number } = { graceMs: 10_000 },
  ) {}

  start(tracks: TrackSpec[]): void {
    for (const spec of tracks) {
      const proc = this.spawnFn('ffmpeg', spec.args);
      const state: TrackState = {
        trackId: spec.trackId,
        kind: spec.kind,
        running: true,
        degraded: false,
        exitCode: null,
        lastError: null,
        segments: 0,
        bytes: 0,
      };
      const entry: Entry = { spec, proc, state, stderrTail: '' };
      this.entries.set(spec.trackId, entry);

      // ffmpeg's diagnostics go to stderr. Keeping the tail turns "the track
      // failed" into "Cannot open display :0.0", which the operator can act on.
      proc.stderr?.on('data', (chunk: Buffer) => {
        entry.stderrTail = (entry.stderrTail + chunk.toString()).slice(-2000);
      });

      proc.on('exit', (code, signal) => this.handleExit(spec.trackId, code, signal));
    }
  }

  handleExit(trackId: string, code: number | null, signal: NodeJS.Signals | string | null): void {
    const entry = this.entries.get(trackId);
    if (!entry) return;

    entry.state.running = false;
    entry.state.exitCode = code;

    // ffmpeg exits 255 on SIGINT. During a stop that is the normal path, not a
    // failure worth showing the operator.
    const cleanStop = this.stopping && (code === 0 || code === 255 || signal === 'SIGINT');
    const cleanExit = code === 0;

    if (!cleanStop && !cleanExit) {
      entry.state.degraded = true;
      const lastLine = entry.stderrTail.trim().split('\n').filter(Boolean).pop();
      entry.state.lastError = lastLine ?? `exited with code ${code ?? 'null'}`;
    }
  }

  /**
   * Stops every track gracefully.
   *
   * SIGINT, never SIGKILL: ffmpeg needs to write the moov atom, and a killed
   * process leaves the final segment as an unplayable file. SIGKILL is a last
   * resort after the grace period, because a wedged encoder must not hold the
   * session open forever.
   */
  async stopAll(): Promise<void> {
    this.stopping = true;

    for (const entry of this.entries.values()) {
      if (entry.state.running) entry.proc.kill('SIGINT');
    }

    const deadline = Date.now() + this.options.graceMs;
    let escalated = false;

    while (this.anyRunning()) {
      if (!escalated && Date.now() >= deadline) {
        escalated = true;
        for (const entry of this.entries.values()) {
          if (entry.state.running) entry.proc.kill('SIGKILL');
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  anyRunning(): boolean {
    return [...this.entries.values()].some((entry) => entry.state.running);
  }

  stateOf(trackId: string): TrackState | undefined {
    return this.entries.get(trackId)?.state;
  }

  /**
   * Current state of every track, with segment counts read from disk.
   *
   * Counted rather than tracked in memory: the files are what actually exist,
   * and a counter could drift from them after a restart or a failed write.
   */
  states(): TrackState[] {
    return [...this.entries.values()].map((entry) => {
      const { segments, bytes } = this.measure(entry.spec.outDir);
      entry.state.segments = segments;
      entry.state.bytes = bytes;
      return entry.state;
    });
  }

  private measure(dir: string): { segments: number; bytes: number } {
    try {
      const files = readdirSync(dir).filter((n) => n.startsWith('seg-'));
      let bytes = 0;
      for (const name of files) {
        try {
          bytes += statSync(join(dir, name)).size;
        } catch {
          // A segment can vanish between listing and stat during rotation;
          // skipping it is better than failing the whole progress report.
        }
      }
      return { segments: files.length, bytes };
    } catch {
      return { segments: 0, bytes: 0 };
    }
  }
}
