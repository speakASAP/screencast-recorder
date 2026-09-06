import { execFile } from 'node:child_process';
import { createWriteStream, WriteStream } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Activity index for later editing. Not a keylogger.
 *
 * The distinction is structural, not a setting: this module has no code path
 * that reads a key symbol. It counts events and names modifier combinations,
 * which is everything an editor needs to find the busy parts of a session, and
 * nothing that could carry a password, a token, or the text of what was
 * written. There is no flag that turns character capture on.
 */

export interface ActivityEvent {
  ts: number;
  display: string | null;
  window: string | null;
  mouse: [number, number] | null;
  clicks: number;
  keys: number;
  hotkeys: string[];
}

export interface EventInput {
  ts: number;
  display?: string | null;
  window?: string | null;
  mouse?: [number, number] | null;
  clicks?: number;
  keys?: number;
  hotkeys?: string[];
}

const MAX_TITLE_LENGTH = 200;

/**
 * Patterns for credential material that turns up in terminal titles.
 *
 * This file is uploaded to S3 and later read by an editing pipeline, so a
 * pasted token in a window title would outlive the session it appeared in.
 */
const SECRET_PATTERNS: RegExp[] = [
  /hvs\.[A-Za-z0-9._-]{6,}/g, // Vault service token
  /hvb\.[A-Za-z0-9._-]{6,}/g, // Vault batch token
  /AKIA[0-9A-Z]{8,}/g, // AWS access key id
  /sk-[A-Za-z0-9_-]{12,}/g, // OpenAI-style secret key
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub token
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b[A-Fa-f0-9]{32,}\b/g, // long hex: hashes, raw keys
];

export function sanitiseWindowTitle(title: string): string {
  let cleaned = title;
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[redacted]');
  }
  return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1)}…` : cleaned;
}

/**
 * Keeps only combinations that include a modifier.
 *
 * "ctrl+s" is editing signal: it marks a save, a build, a commit. A bare "a" is
 * the content of what the user typed, which is exactly what this system does
 * not record.
 */
export function filterHotkeys(pressed: string[]): string[] {
  const MODIFIERS = ['ctrl', 'alt', 'shift', 'super', 'meta', 'cmd'];
  return pressed.filter((combo) => {
    const parts = combo.toLowerCase().split('+');
    if (parts.length < 2) return false;
    return parts.slice(0, -1).every((part) => MODIFIERS.includes(part)) && parts.length >= 2;
  });
}

export function buildEvent(input: EventInput): ActivityEvent {
  return {
    ts: input.ts,
    display: input.display ?? null,
    window: input.window === undefined || input.window === null ? null : sanitiseWindowTitle(input.window),
    mouse: input.mouse ?? null,
    // Defaulted rather than left undefined: a JSONL reader assumes uniform
    // records, and a half-written line breaks the whole stream.
    clicks: input.clicks ?? 0,
    keys: input.keys ?? 0,
    hotkeys: filterHotkeys(input.hotkeys ?? []),
  };
}

export function parseMouseLocation(output: string): [number, number] | null {
  const match = output.match(/x:(\d+)\s+y:(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

async function tryRun(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(command, args, { timeout: 2000 });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Samples desktop activity into a JSONL file.
 *
 * Counters are supplied by the caller (the input listener) and reset each tick,
 * so a sample says "17 keypresses in the last 200ms", never which keys.
 */
export class ActivityTracker {
  private stream: WriteStream | null = null;
  private timer: NodeJS.Timeout | null = null;
  private clicks = 0;
  private keys = 0;
  private hotkeys: string[] = [];
  private lastWindow: string | null = null;

  constructor(
    private readonly path: string,
    private readonly sampleHz: number,
    private readonly display: string,
  ) {}

  /** Called by the input listener; deliberately takes no key identity. */
  countKey(hotkey?: string): void {
    this.keys += 1;
    if (hotkey) this.hotkeys.push(hotkey);
  }

  countClick(): void {
    this.clicks += 1;
  }

  start(): void {
    this.stream = createWriteStream(this.path, { flags: 'a' });
    const intervalMs = Math.max(50, Math.round(1000 / this.sampleHz));
    this.timer = setInterval(() => void this.sample(), intervalMs);
  }

  private async sample(): Promise<void> {
    const [windowOut, mouseOut] = await Promise.all([
      tryRun('xdotool', ['getactivewindow', 'getwindowname']),
      tryRun('xdotool', ['getmouselocation']),
    ]);

    const window = windowOut.trim() || this.lastWindow;
    this.lastWindow = window;

    const event = buildEvent({
      ts: Date.now() / 1000,
      display: this.display,
      window,
      mouse: parseMouseLocation(mouseOut),
      clicks: this.clicks,
      keys: this.keys,
      hotkeys: this.hotkeys,
    });

    this.clicks = 0;
    this.keys = 0;
    this.hotkeys = [];

    // One line per sample, flushed as written: a crash costs at most one
    // sample rather than a buffer's worth.
    this.stream?.write(`${JSON.stringify(event)}\n`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    await new Promise<void>((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
    });
    this.stream = null;
  }

  /** Live readout for the operator's recording screen. Never persisted. */
  currentWindow(): string | null {
    return this.lastWindow;
  }
}
