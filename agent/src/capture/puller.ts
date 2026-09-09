import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';

export type SpawnFn = (command: string, args: string[]) => ChildProcess;

export interface PullerSpec {
  /** The camera's stream URL, e.g. an IP Camera Lite MJPEG endpoint. */
  sourceUrl: string;
  /** The v4l2loopback node the stream is written into. */
  device: string;
}

export interface PullerStatus {
  running: boolean;
  /** Why it stopped, when it stopped on its own. Null while running. */
  lastExitCode: number | null;
  lastError: string | null;
  device: string | null;
}

/**
 * Feeds a phone's camera stream into a v4l2loopback device.
 *
 * This exists because a phone is not a webcam: nothing plugs it in, so
 * something has to pull its stream and write it to the node the recorder
 * reads. That process has proven fragile in practice -- it has died when the
 * phone app restarted, and when the host ran short of memory -- and a dead
 * puller leaves a device that opens and delivers nothing.
 *
 * So its state is reported rather than assumed: the console shows whether it
 * is running, and a recording refuses to start against a camera with no
 * signal instead of writing an empty track.
 */
export function buildPullerArgs(spec: PullerSpec): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'mjpeg',
    '-i', spec.sourceUrl,
    // The phone sends full-range JPEG; yuv420p is what a V4L2 consumer expects,
    // and converting here means every reader downstream negotiates cleanly.
    '-vf', 'format=yuv420p',
    '-f', 'v4l2',
    spec.device,
  ];
}

export interface PullerDeps {
  spawnFn?: SpawnFn;
}

export class PullerSupervisor {
  private child: ChildProcess | null = null;
  private lastExitCode: number | null = null;
  private lastError: string | null = null;
  private device: string | null = null;
  private readonly spawnFn: SpawnFn;

  constructor(deps: PullerDeps = {}) {
    this.spawnFn = deps.spawnFn ?? ((command, args) => nodeSpawn(command, args));
  }

  /**
   * Starts the puller, or does nothing if one is already running.
   *
   * The guard is load-bearing: two writers on one loopback device is exactly
   * the state that left the node unreadable in practice -- the second fails to
   * attach and the first is no longer readable either.
   */
  start(spec: PullerSpec): void {
    if (this.child) return;

    this.lastExitCode = null;
    this.lastError = null;
    this.device = spec.device;

    const child = this.spawnFn('ffmpeg', buildPullerArgs(spec));
    this.child = child;

    // Kept only as the last line, for the console: a stalled camera reports a
    // specific ffmpeg message, and a bare exit code cannot say which.
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk).trim();
      if (text) this.lastError = text.split('\n').pop() ?? null;
    });

    child.on('error', (error: Error) => {
      this.lastError = error.message;
    });

    child.on('close', (code: number | null) => {
      this.child = null;
      this.lastExitCode = code;
    });
  }

  /** Stops the puller. Safe when nothing is running. */
  stop(): void {
    if (!this.child) return;
    // SIGINT, not SIGKILL: ffmpeg closes the device cleanly, and a device left
    // open by a killed writer is what needs a module reload to recover.
    this.child.kill('SIGINT');
    this.child = null;
  }

  status(): PullerStatus {
    return {
      running: this.child !== null,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError,
      device: this.device,
    };
  }
}
