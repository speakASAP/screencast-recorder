/**
 * Parses and buckets the activity stream for display.
 *
 * Pure and dependency-free: these rules are the correctness core of the
 * timeline, and they are cheapest to pin without I/O in the way.
 *
 * Keys and clicks are bucketed alongside mouse movement, and `inputMeasured`
 * says whether they mean anything. The counters have a producer now
 * (`agent/src/activity/input-listener.ts` feeds ActivityTracker.countKey and
 * countClick), but sessions recorded before that listener existed are in the
 * bucket permanently and report `keys: 0, clicks: 0` on every sample. Drawing
 * those zeroes would tell the operator the session was quiet when the signal
 * was never recorded, so the flag lets the console say "not measured" instead.
 *
 * A genuinely motionless session is indistinguishable from an unmeasured one
 * and is reported as unmeasured. That error runs in the safe direction: it
 * understates what is known rather than asserting a quiet session that was
 * never observed.
 */

export interface ActivitySample {
  ts: number;
  display: string | null;
  window: string | null;
  mouse: [number, number] | null;
  clicks: number;
  keys: number;
  hotkeys: string[];
}

export interface FocusInterval {
  window: string;
  startMs: number;
  endMs: number;
}

export interface TimelineBucket {
  startMs: number;
  endMs: number;
  mouseMovement: number;
  keys: number;
  clicks: number;
  window: string | null;
}

export interface Timeline {
  durationMs: number;
  bucketMs: number;
  buckets: TimelineBucket[];
  focus: FocusInterval[];
  topWindows: { window: string; totalMs: number }[];
  sampleCount: number;
  /** False when no sample carried a count, i.e. the signal was never recorded. */
  inputMeasured: boolean;
}


/**
 * Patterns for credential material that turns up in terminal titles.
 *
 * Deliberately a second copy of the agent's list, not a shared import. The
 * agent sanitises on write and this sanitises on read, and they are separated
 * by an object store: `events.jsonl` files recorded before the agent's
 * sanitiser existed are already in the bucket, and preview is the first thing
 * that puts a window title on a screen. A redaction that only ever ran at
 * capture time cannot protect a file that was captured without it.
 *
 * The two lists are allowed to diverge in the safe direction -- either side
 * may add a pattern -- but neither may drop one on the grounds that the other
 * covers it.
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

const MAX_TITLE_LENGTH = 200;

/** Redacts and truncates a stored window title on the way out to the console. */
export function redactStoredTitle(title: string): string {
  let cleaned = title;
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[redacted]');
  }
  return cleaned.length > MAX_TITLE_LENGTH
    ? `${cleaned.slice(0, MAX_TITLE_LENGTH - 1)}\u2026`
    : cleaned;
}

export function parseSamples(jsonl: string): ActivitySample[] {
  const samples: ActivitySample[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ActivitySample;
      if (typeof parsed.ts !== 'number') continue;
      // Redact on read, not only on write: a file recorded before the agent's
      // sanitiser existed is already in the bucket, and this is the first
      // place its titles are shown to anyone.
      if (typeof parsed.window === 'string') {
        parsed.window = redactStoredTitle(parsed.window);
      }
      samples.push(parsed);
    } catch {
      // A truncated final line costs one sample, not the session.
    }
  }
  return samples.sort((a, b) => a.ts - b.ts);
}

export function buildTimeline(samples: ActivitySample[], bucketCount: number): Timeline {
  const count = Math.max(1, bucketCount);
  if (samples.length === 0) {
    return {
      durationMs: 0,
      bucketMs: 0,
      buckets: [],
      focus: [],
      topWindows: [],
      sampleCount: 0,
      inputMeasured: false,
    };
  }

  const originMs = samples[0].ts * 1000;
  const durationMs = Math.max(1, samples[samples.length - 1].ts * 1000 - originMs);
  const bucketMs = durationMs / count;

  const buckets: TimelineBucket[] = Array.from({ length: count }, (_, i) => ({
    startMs: Math.round(i * bucketMs),
    endMs: Math.round((i + 1) * bucketMs),
    mouseMovement: 0,
    keys: 0,
    clicks: 0,
    window: null,
  }));

  // Counts are read defensively: a session recorded before the input listener
  // has zeroes, and an older line may omit the fields entirely. Either way the
  // arithmetic must not produce NaN and poison the whole bucket.
  let inputMeasured = false;

  const focus: FocusInterval[] = [];
  const windowTotals = new Map<string, number>();

  samples.forEach((sample, index) => {
    const offsetMs = sample.ts * 1000 - originMs;
    const slot = Math.min(count - 1, Math.floor(offsetMs / bucketMs));

    const previous = index > 0 ? samples[index - 1] : null;
    if (previous?.mouse && sample.mouse) {
      buckets[slot].mouseMovement +=
        Math.abs(sample.mouse[0] - previous.mouse[0]) + Math.abs(sample.mouse[1] - previous.mouse[1]);
    }

    const keys = Number.isFinite(sample.keys) ? sample.keys : 0;
    const clicks = Number.isFinite(sample.clicks) ? sample.clicks : 0;
    buckets[slot].keys += keys;
    buckets[slot].clicks += clicks;
    // A hotkey counts as evidence on its own: it proves the listener was
    // running even in a sample where the key total happens to be zero.
    if (keys > 0 || clicks > 0 || (sample.hotkeys?.length ?? 0) > 0) inputMeasured = true;

    if (sample.window) {
      buckets[slot].window ??= sample.window;

      const open = focus[focus.length - 1];
      if (open && open.window === sample.window) {
        open.endMs = offsetMs;
      } else {
        focus.push({ window: sample.window, startMs: offsetMs, endMs: offsetMs });
      }

      if (previous) {
        const held = offsetMs - (previous.ts * 1000 - originMs);
        windowTotals.set(sample.window, (windowTotals.get(sample.window) ?? 0) + held);
      }
    }
  });

  const topWindows = [...windowTotals.entries()]
    .map(([window, totalMs]) => ({ window, totalMs: Math.round(totalMs) }))
    .sort((a, b) => b.totalMs - a.totalMs);

  return {
    durationMs: Math.round(durationMs),
    bucketMs: Math.round(bucketMs),
    buckets,
    focus: focus.map((f) => ({ ...f, startMs: Math.round(f.startMs), endMs: Math.round(f.endMs) })),
    topWindows,
    sampleCount: samples.length,
    inputMeasured,
  };
}
