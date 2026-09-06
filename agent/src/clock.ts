import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * How late a `start` command may arrive and still be honoured.
 *
 * Beyond this the agent reports `t0_missed` instead of starting: joining a
 * session late produces tracks that silently disagree with every other track's
 * timeline, which is worse than not recording at all.
 */
export const T0_TOLERANCE_MS = 2000;

/** Largest clock error still considered synchronised, in milliseconds. */
const MAX_OFFSET_MS = 100;

export interface ClockState {
  synchronised: boolean;
  offset_ms: number;
  source: string;
}

/**
 * Parses `chronyc tracking`.
 *
 * The "System time" line reads either "N seconds fast of NTP time" or
 * "N seconds slow of NTP time"; the direction matters, because the recorded
 * offset is what a later editing stage uses to align tracks from different
 * machines.
 */
export function parseChronyTracking(output: string): ClockState {
  if (output.trim() === '') {
    return { synchronised: false, offset_ms: 0, source: 'unavailable' };
  }

  const systemTime = output.match(
    /System time\s*:\s*([\d.]+)\s+seconds\s+(fast|slow)\s+of\s+NTP time/i,
  );
  const leap = output.match(/Leap status\s*:\s*(.+)/i)?.[1]?.trim() ?? '';
  const reference = output.match(/Reference ID\s*:\s*(\S+)/i)?.[1] ?? 'chrony';

  if (!systemTime) {
    return { synchronised: false, offset_ms: 0, source: reference };
  }

  const magnitudeMs = Number(systemTime[1]) * 1000;
  const offsetMs = systemTime[2].toLowerCase() === 'fast' ? magnitudeMs : -magnitudeMs;

  // Both conditions are required. A normal leap status with a large offset
  // still means the clock is wrong; a small offset with "Not synchronised"
  // means chrony has lost its source and the offset is about to drift.
  const leapOk = /normal/i.test(leap);
  const offsetOk = Math.abs(offsetMs) <= MAX_OFFSET_MS;

  return {
    synchronised: leapOk && offsetOk,
    offset_ms: Math.round(offsetMs),
    source: reference,
  };
}

export async function checkClock(): Promise<ClockState> {
  try {
    const { stdout } = await run('chronyc', ['tracking'], { timeout: 10_000 });
    return parseChronyTracking(stdout);
  } catch {
    return { synchronised: false, offset_ms: 0, source: 'unavailable' };
  }
}

export function msUntil(t0: Date): number {
  return t0.getTime() - Date.now();
}

export function t0Missed(t0: Date): boolean {
  return msUntil(t0) < -T0_TOLERANCE_MS;
}

/**
 * Sleeps until `t0`.
 *
 * Coarse sleeps until the last stretch, then a tight loop for the final
 * milliseconds: `setTimeout` alone can overshoot by tens of milliseconds under
 * load, and every millisecond of overshoot is drift between two machines'
 * tracks.
 */
export async function waitUntil(t0: Date): Promise<void> {
  const SPIN_THRESHOLD_MS = 50;

  for (;;) {
    const remaining = msUntil(t0);
    if (remaining <= 0) return;

    if (remaining > SPIN_THRESHOLD_MS) {
      await new Promise((resolve) => setTimeout(resolve, remaining - SPIN_THRESHOLD_MS));
    } else {
      while (msUntil(t0) > 0) {
        /* spin the last few milliseconds */
      }
      return;
    }
  }
}
