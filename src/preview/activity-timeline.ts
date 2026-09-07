/**
 * Parses and buckets the activity stream for display.
 *
 * Pure and dependency-free: these rules are the correctness core of the
 * timeline, and they are cheapest to pin without I/O in the way.
 *
 * Deliberately emits no keys/clicks field. ActivityTracker.countKey and
 * countClick have no caller in agent/src, so every stored session reports
 * zeroes; surfacing a zero would tell the operator the session was quiet when
 * the signal was never recorded. See the defect in TASKS.md.
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
  window: string | null;
}

export interface Timeline {
  durationMs: number;
  bucketMs: number;
  buckets: TimelineBucket[];
  focus: FocusInterval[];
  topWindows: { window: string; totalMs: number }[];
  sampleCount: number;
}

export function parseSamples(jsonl: string): ActivitySample[] {
  const samples: ActivitySample[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ActivitySample;
      if (typeof parsed.ts === 'number') samples.push(parsed);
    } catch {
      // A truncated final line costs one sample, not the session.
    }
  }
  return samples.sort((a, b) => a.ts - b.ts);
}

export function buildTimeline(samples: ActivitySample[], bucketCount: number): Timeline {
  const count = Math.max(1, bucketCount);
  if (samples.length === 0) {
    return { durationMs: 0, bucketMs: 0, buckets: [], focus: [], topWindows: [], sampleCount: 0 };
  }

  const originMs = samples[0].ts * 1000;
  const durationMs = Math.max(1, samples[samples.length - 1].ts * 1000 - originMs);
  const bucketMs = durationMs / count;

  const buckets: TimelineBucket[] = Array.from({ length: count }, (_, i) => ({
    startMs: Math.round(i * bucketMs),
    endMs: Math.round((i + 1) * bucketMs),
    mouseMovement: 0,
    window: null,
  }));

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
  };
}
