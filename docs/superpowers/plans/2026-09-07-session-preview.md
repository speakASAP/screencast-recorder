# Session Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator see what a stored session contains — the screen video, its audio, and a timeline of window focus and mouse movement — before deciding whether to keep it.

**Architecture:** The agent renders a low-resolution faststart video proxy plus one separate audio proxy per source, because it has the GPU, 24 cores and the files while the API pod has 500m CPU, no `/dev/dri` and no ffmpeg. The API presigns GETs for those objects and separately parses `events.jsonl` into ~1000 buckets server-side. The browser plays a plain `<video>` (Range requests give seeking for free) alongside one `<audio>` element per source, beside a timeline canvas.

**Tech Stack:** NestJS 10, TypeORM 0.3, Postgres, `@aws-sdk/client-s3` (+ `@aws-sdk/s3-request-presigner`), ffmpeg/VAAPI on the agent, framework-free vanilla JS frontend, Jest + ts-jest.

**Spec:** [`docs/superpowers/specs/2026-09-07-session-preview-design.md`](../specs/2026-09-07-session-preview-design.md)

## Global Constraints

- **Preview routes are the OPERATOR lane.** No `@AgentRoute()`, no `@Public()`. The global `UserAuthGuard` covers them. The `render-preview` command travels the existing agent long-poll channel.
- **Never weaken the storage boundary.** No public bucket policy, no root credential, no widening the scoped policy beyond `screencast-sessions`. Presigning uses the already-granted `s3:GetObject`. If bucket CORS turns out to be genuinely required, **stop and raise it** — do not configure the bucket.
- **Delete nothing.** No local media, no objects, no rows. No code path in this work may delete. Preview is not a gate on retention and authorises no deletion.
- **Keys and clicks must never render as a zero value, a flat line, or an empty bar.** They are omitted with a note pointing at the defect in `TASKS.md`.
- **Every audio source must be reachable.** One audio proxy per source at 24 kbps mono 22.05 kHz; the video proxy carries no audio stream. Switching source must never reload the video. A preview missing any audio proxy is not `ready`.
- **The activity stream contains no keystroke content and must never start to.**
- **A render never contends with a recording** — refused or deferred in code when `capture.isRunning()` is true.
- **No silent failures.** "Not found" and "lookup failed" stay distinguishable. Every catch re-throws or logs with full context.
- Do not change how the agent selects or records audio sources. Do not modify `ActivityTracker`.
- Tests run with `npx jest` from the repo root and cover both `src/` and `agent/`. Baseline is 174 across 23 suites.
- Commit to `main` auto-deploys. Verify by pod image and age, not the deploy banner.

---

### Task 1: Activity timeline bucketing (pure module)

Pure, dependency-free parsing and bucketing. No I/O, no Nest, so it is the cheapest place to pin the rules that matter.

**Files:**
- Create: `src/preview/activity-timeline.ts`
- Test: `src/preview/activity-timeline.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ActivitySample { ts: number; display: string | null; window: string | null; mouse: [number, number] | null; clicks: number; keys: number; hotkeys: string[] }`
  - `interface FocusInterval { window: string; startMs: number; endMs: number }`
  - `interface TimelineBucket { startMs: number; endMs: number; mouseMovement: number; window: string | null }`
  - `interface Timeline { durationMs: number; bucketMs: number; buckets: TimelineBucket[]; focus: FocusInterval[]; topWindows: { window: string; totalMs: number }[]; sampleCount: number }`
  - `function parseSamples(jsonl: string): ActivitySample[]`
  - `function buildTimeline(samples: ActivitySample[], bucketCount: number): Timeline`

- [ ] **Step 1: Write the failing test**

```typescript
// src/preview/activity-timeline.spec.ts
import { buildTimeline, parseSamples } from './activity-timeline';

const line = (ts: number, window: string, mouse: [number, number] | null) =>
  JSON.stringify({ ts, display: 'HDMI-A-0', window, mouse, clicks: 0, keys: 0, hotkeys: [] });

describe('parseSamples', () => {
  it('skips a truncated trailing line rather than throwing', () => {
    // A crash mid-write leaves a partial last line; the rest of the session is
    // still readable and must not be lost to it.
    const jsonl = `${line(100, 'A', [0, 0])}\n{"ts":101,"window":"B"`;
    expect(parseSamples(jsonl)).toHaveLength(1);
  });
});

describe('buildTimeline', () => {
  it('produces exactly the requested bucket count regardless of duration', () => {
    const samples = parseSamples(
      Array.from({ length: 50 }, (_, i) => line(1000 + i * 0.2, 'A', [i, i])).join('\n'),
    );
    expect(buildTimeline(samples, 10).buckets).toHaveLength(10);
  });

  it('collapses consecutive samples of one window into a single focus interval', () => {
    const samples = parseSamples(
      [line(1000, 'A', null), line(1000.2, 'A', null), line(1000.4, 'B', null)].join('\n'),
    );
    const focus = buildTimeline(samples, 4).focus;
    expect(focus.map((f) => f.window)).toEqual(['A', 'B']);
  });

  it('sums absolute mouse movement into the bucket', () => {
    const samples = parseSamples([line(1000, 'A', [0, 0]), line(1000.2, 'A', [3, 4])].join('\n'));
    expect(buildTimeline(samples, 1).buckets[0].mouseMovement).toBe(7);
  });

  it('ranks top windows by total focus time', () => {
    const samples = parseSamples(
      [line(1000, 'A', null), line(1000.2, 'B', null), line(1000.4, 'B', null)].join('\n'),
    );
    expect(buildTimeline(samples, 4).topWindows[0].window).toBe('B');
  });

  it('never reports keys or clicks, which are not captured', () => {
    // countKey/countClick have no caller in agent/src, so every stored session
    // reports zeroes. Emitting a zero here would read as a quiet session
    // rather than an absent feature. See the defect in TASKS.md.
    const timeline = buildTimeline(parseSamples(line(1000, 'A', [0, 0])), 1);
    expect(JSON.stringify(timeline)).not.toMatch(/"keys"|"clicks"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/preview/activity-timeline.spec.ts`
Expected: FAIL — `Cannot find module './activity-timeline'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/preview/activity-timeline.ts

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/preview/activity-timeline.spec.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/preview/activity-timeline.ts src/preview/activity-timeline.spec.ts
git commit -m "feat(preview): bucket the activity stream for display"
```

---

### Task 2: Audio source levels and initial selection (pure module)

Every source is rendered and reachable; this module decides which one the
console starts on, and labels the levels. It does **not** decide which source
gets rendered — all of them do.

**Files:**
- Create: `src/preview/audio-selection.ts`
- Test: `src/preview/audio-selection.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const DIGITAL_SILENCE_DB = -91`
  - `interface AudioSourceLevel { sourceRef: string; meanDb: number; maxDb: number }`
  - `interface AudioSourceView extends AudioSourceLevel { silent: boolean; selected: boolean; reason: string }`
  - `function selectAudioSource(levels: AudioSourceLevel[], override?: string): AudioSourceView[]`
  - `function parseVolumedetect(stderr: string): { meanDb: number; maxDb: number }`
  - `function audioObjectKey(prefix: string, sourceRef: string): string`
  - `function missingAudioProxies(expectedSourceRefs: string[], renderedKeys: string[], prefix: string): string[]`

- [ ] **Step 1: Write the failing test**

```typescript
// src/preview/audio-selection.spec.ts
import {
  audioObjectKey,
  missingAudioProxies,
  parseVolumedetect,
  selectAudioSource,
} from './audio-selection';

const level = (sourceRef: string, meanDb: number, maxDb: number) => ({ sourceRef, meanDb, maxDb });

describe('parseVolumedetect', () => {
  it('reads mean and max from ffmpeg volumedetect output', () => {
    const stderr = [
      '[Parsed_volumedetect_0 @ 0x1] mean_volume: -57.2 dB',
      '[Parsed_volumedetect_0 @ 0x1] max_volume: -20.3 dB',
    ].join('\n');
    expect(parseVolumedetect(stderr)).toEqual({ meanDb: -57.2, maxDb: -20.3 });
  });
});

describe('selectAudioSource', () => {
  it('selects the loudest source and says why', () => {
    const view = selectAudioSource([level('jabra', -91, -91), level('usb2', -57.2, -20.3)]);
    const chosen = view.find((v) => v.selected);
    expect(chosen?.sourceRef).toBe('usb2');
    expect(chosen?.reason).toBe('selected automatically: highest measured level');
  });

  it('labels a source at digital silence as such, not as merely quiet', () => {
    // -91.0 dB mean AND max is digital silence: it usually means the device
    // was not the active input. It does not mean the track is defective.
    const view = selectAudioSource([level('jabra', -91, -91), level('usb2', -57.2, -20.3)]);
    expect(view.find((v) => v.sourceRef === 'jabra')?.silent).toBe(true);
    expect(view.find((v) => v.sourceRef === 'usb2')?.silent).toBe(false);
  });

  it('honours a manual override and says the choice was the operator’s', () => {
    const view = selectAudioSource([level('jabra', -91, -91), level('usb2', -57.2, -20.3)], 'jabra');
    const chosen = view.find((v) => v.selected);
    expect(chosen?.sourceRef).toBe('jabra');
    expect(chosen?.reason).toBe('selected by the operator');
  });

  it('selects nothing when there are no audio sources', () => {
    expect(selectAudioSource([])).toEqual([]);
  });

  it('keeps every source in the view, including the silent ones', () => {
    // All sources are rendered and reachable; selection only decides which
    // one the console starts on. Dropping a silent source here would make it
    // unreachable, which is the failure this design exists to prevent.
    const view = selectAudioSource([
      level('jabra', -91, -91), level('usb1', -91, -91), level('usb2', -57.2, -20.3),
    ]);
    expect(view.map((v) => v.sourceRef).sort()).toEqual(['jabra', 'usb1', 'usb2']);
  });
});

describe('missingAudioProxies', () => {
  it('names the sources whose proxy was not rendered', () => {
    // Three sources with two proxies is an incomplete preview, and the
    // missing one is exactly the one the operator would have needed.
    const missing = missingAudioProxies(
      ['jabra', 'usb1', 'usb2'],
      ['p/preview/audio-jabra.m4a', 'p/preview/audio-usb2.m4a'],
      'p',
    );
    expect(missing).toEqual(['usb1']);
  });

  it('reports nothing missing for a complete set', () => {
    const missing = missingAudioProxies(
      ['jabra'], ['p/preview/audio-jabra.m4a'], 'p',
    );
    expect(missing).toEqual([]);
  });
});

describe('audioObjectKey', () => {
  it('makes a filesystem-safe key from a PipeWire source name', () => {
    // Real source refs contain dots and hyphens, e.g.
    // alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback
    const key = audioObjectKey('sessions/2026/09/07/s1', 'alsa_input.usb-_Jabra_Link_390-00.mono-fallback');
    expect(key.startsWith('sessions/2026/09/07/s1/preview/audio-')).toBe(true);
    expect(key.endsWith('.m4a')).toBe(true);
    expect(key).not.toMatch(/\s/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/preview/audio-selection.spec.ts`
Expected: FAIL — `Cannot find module './audio-selection'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/preview/audio-selection.ts

/**
 * Levels and initial audio selection for the preview.
 *
 * EVERY source is rendered to its own proxy file and is reachable in the
 * console. This module only decides which one playback starts on, and labels
 * what each source captured.
 *
 * That shape exists because a browser plays only the first audio track of a
 * <video> element and exposes no switcher, so muxing several streams into one
 * file would leave all but the first unreachable. Separate files plus separate
 * <audio> elements is what makes every source actually selectable.
 *
 * "Loudest" is only a starting point, never the whole mechanism: the owner
 * uses different headsets across sessions, so which source carried signal
 * varies. Auto-selecting a single track to render would sometimes render the
 * wrong one and leave the right one unreachable -- and it would fail silently,
 * because a preview that plays some audio looks like it is working.
 */

/** ffmpeg reports a stream with no signal at all as exactly -91.0 dB. */
export const DIGITAL_SILENCE_DB = -91;

export interface AudioSourceLevel {
  sourceRef: string;
  meanDb: number;
  maxDb: number;
}

export interface AudioSourceView extends AudioSourceLevel {
  silent: boolean;
  selected: boolean;
  reason: string;
}

export function parseVolumedetect(stderr: string): { meanDb: number; maxDb: number } {
  const read = (key: string): number => {
    const match = stderr.match(new RegExp(`${key}:\\s*(-?[0-9.]+) dB`));
    return match ? Number(match[1]) : DIGITAL_SILENCE_DB;
  };
  return { meanDb: read('mean_volume'), maxDb: read('max_volume') };
}

export function selectAudioSource(
  levels: AudioSourceLevel[],
  override?: string,
): AudioSourceView[] {
  if (levels.length === 0) return [];

  const loudest = [...levels].sort((a, b) => b.maxDb - a.maxDb)[0];
  const chosen = override && levels.some((l) => l.sourceRef === override) ? override : loudest.sourceRef;
  const byOperator = chosen === override;

  return levels.map((level) => ({
    ...level,
    // Both mean and max at the floor: no signal was present at any point.
    silent: level.meanDb <= DIGITAL_SILENCE_DB && level.maxDb <= DIGITAL_SILENCE_DB,
    selected: level.sourceRef === chosen,
    reason:
      level.sourceRef === chosen
        ? byOperator
          ? 'selected by the operator'
          : 'selected automatically: highest measured level'
        : '',
  }));
}

/**
 * Object key for one source's audio proxy.
 *
 * A PipeWire source ref carries dots and hyphens
 * (alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback), so it is
 * slugged rather than interpolated raw -- an unslugged ref would produce keys
 * that are awkward to round-trip through a URL path segment.
 */
export function audioObjectKey(prefix: string, sourceRef: string): string {
  const slug = sourceRef.replace(/[^A-Za-z0-9_-]+/g, '_');
  return `${prefix}/preview/audio-${slug}.m4a`;
}

/**
 * Names the sources whose proxy is absent.
 *
 * A preview offering two of three sources is worse than one that reports
 * itself incomplete: the missing source is exactly the one the operator would
 * have needed, and a partial set that reports ready hides that.
 */
export function missingAudioProxies(
  expectedSourceRefs: string[],
  renderedKeys: string[],
  prefix: string,
): string[] {
  const rendered = new Set(renderedKeys);
  return expectedSourceRefs.filter((ref) => !rendered.has(audioObjectKey(prefix, ref)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/preview/audio-selection.spec.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/preview/audio-selection.ts src/preview/audio-selection.spec.ts
git commit -m "feat(preview): pick the proxy audio source by measured level"
```

---

### Task 3: The `session_preview` entity and migration

**Files:**
- Create: `src/preview/session-preview.entity.ts`
- Create: `src/database/migrations/1757200300000-SessionPreview.ts`
- Test: `src/preview/session-preview.entity.spec.ts`
- Modify: `src/database/data-source.ts` (register the entity and migration if it lists them explicitly)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `enum PreviewState { Pending = 'pending', Rendering = 'rendering', Ready = 'ready', Failed = 'failed' }`
  - `interface PreviewArtifact { kind: 'video' | 'audio'; sourceRef: string | null; objectKey: string; bytes: number; durationMs: number | null }`
  - `class SessionPreview` with `id`, `sessionId`, `state`, `artifacts` (`PreviewArtifact[]`, jsonb), `sourcePath` (`'local' | 'storage' | null`), `failureReason` (`string | null`), `requestedAt`, `readyAt`
  - `function isLegalPreviewTransition(from: PreviewState, to: PreviewState): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// src/preview/session-preview.entity.spec.ts
import { PreviewState, isLegalPreviewTransition } from './session-preview.entity';

describe('preview transitions', () => {
  it('allows the render path and the retry of a failure', () => {
    expect(isLegalPreviewTransition(PreviewState.Pending, PreviewState.Rendering)).toBe(true);
    expect(isLegalPreviewTransition(PreviewState.Rendering, PreviewState.Ready)).toBe(true);
    expect(isLegalPreviewTransition(PreviewState.Rendering, PreviewState.Failed)).toBe(true);
    expect(isLegalPreviewTransition(PreviewState.Failed, PreviewState.Rendering)).toBe(true);
  });

  it('refuses to move on from a ready preview', () => {
    // A ready proxy is reusable; re-rendering it would be wasted GPU time and
    // would swap the object out from under a player that is mid-seek.
    expect(isLegalPreviewTransition(PreviewState.Ready, PreviewState.Rendering)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/preview/session-preview.entity.spec.ts`
Expected: FAIL — `Cannot find module './session-preview.entity'`

- [ ] **Step 3: Write the entity and migration**

```typescript
// src/preview/session-preview.entity.ts
import { randomUUID } from 'node:crypto';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export enum PreviewState {
  Pending = 'pending',
  Rendering = 'rendering',
  Ready = 'ready',
  Failed = 'failed',
}

const LEGAL: Record<PreviewState, PreviewState[]> = {
  [PreviewState.Pending]: [PreviewState.Rendering, PreviewState.Failed],
  [PreviewState.Rendering]: [PreviewState.Ready, PreviewState.Failed],
  // Retry after a failure is the whole recovery path.
  [PreviewState.Failed]: [PreviewState.Rendering],
  // A ready proxy is reusable and is never re-rendered in place.
  [PreviewState.Ready]: [],
};

export function isLegalPreviewTransition(from: PreviewState, to: PreviewState): boolean {
  return LEGAL[from].includes(to);
}

/** One rendered object: the video proxy, or one source's audio proxy. */
export interface PreviewArtifact {
  kind: 'video' | 'audio';
  /** Null for the video proxy, which carries no audio stream. */
  sourceRef: string | null;
  objectKey: string;
  bytes: number;
  durationMs: number | null;
}

/**
 * One preview per session -- NOT one per audio source.
 *
 * A render produces the whole set at once (the video proxy plus one audio
 * proxy per source), because every source must be reachable: a browser plays
 * only the first audio track of a <video>, so muxing would strand all but one.
 * Rendering them together means switching source in the console costs nothing
 * and needs no second render.
 *
 * The artifact list is what makes completeness checkable rather than assumed:
 * a session with three audio sources and two audio proxies is incomplete, and
 * must be visible as such rather than quietly offering two.
 */
@Entity('session_previews')
@Index(['sessionId'], { unique: true })
export class SessionPreview {
  @PrimaryColumn({ type: 'uuid' })
  id: string = randomUUID();

  @Column({ type: 'uuid' })
  sessionId!: string;

  @Column({ type: 'text', default: PreviewState.Pending })
  state!: PreviewState;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  artifacts!: PreviewArtifact[];

  /** Which path the render read from; the two have very different waits. */
  @Column({ type: 'text', nullable: true })
  sourcePath!: 'local' | 'storage' | null;

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  readyAt!: Date | null;
}
```

```typescript
// src/database/migrations/1757200300000-SessionPreview.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rendered preview proxies, one row per session.
 *
 * The rendered objects live in the `artifacts` jsonb rather than in columns,
 * because a session has one video proxy and a variable number of audio
 * proxies -- one per capture source -- and that set is what completeness is
 * checked against.
 *
 * No foreign key cascade delete is declared here beyond the session link,
 * and nothing in the preview subsystem deletes rows or objects.
 */
export class SessionPreview1757200300000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "session_previews" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "sessionId" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
        "state" text NOT NULL DEFAULT 'pending',
        "artifacts" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "sourcePath" text,
        "failureReason" text,
        "requestedAt" timestamptz NOT NULL DEFAULT now(),
        "readyAt" timestamptz
      )
    `);
    // One preview per session; a repeat request reuses the row.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_session_previews_session"
      ON "session_previews" ("sessionId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_session_previews_session"`);
    await queryRunner.query(`DROP TABLE "session_previews"`);
  }
}
```

**Note on `gen_random_uuid()`:** phase 1 hit a defect where `@PrimaryGeneratedColumn('uuid')` inserted NULL without a database default. This migration declares the default explicitly for that reason.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/preview/session-preview.entity.spec.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Verify the migration against a scratch database, never production**

Migrations run via `migrationsRun: true` at boot and there is no standalone data-source, so check it with a direct `DataSource` script against a scratch database. Confirm the table and unique index exist and that `down` reverses cleanly.

- [ ] **Step 6: Commit**

```bash
git add src/preview/session-preview.entity.ts src/preview/session-preview.entity.spec.ts src/database/migrations/1757200300000-SessionPreview.ts
git commit -m "feat(preview): add the session_previews table"
```

---

### Task 4: Presigned media URL

**Files:**
- Modify: `src/storage/storage.service.ts`
- Modify: `src/storage/storage.module.ts` (no change expected; confirm `S3_CLIENT` is exported for injection)
- Test: `src/storage/storage.service.spec.ts`
- Modify: `package.json` — add `@aws-sdk/s3-request-presigner`

**Interfaces:**
- Consumes: `S3_CLIENT`, `S3_BUCKET` from `src/storage/storage.service.ts`.
- Produces: `StorageService.presignGet(key: string, expirySeconds: number): Promise<string>`, `StorageService.getObjectText(key: string): Promise<string | null>`

- [ ] **Step 1: Install the presigner**

```bash
npm install @aws-sdk/s3-request-presigner
```

- [ ] **Step 2: Write the failing test**

```typescript
// append to src/storage/storage.service.spec.ts
describe('getObjectText', () => {
  it('returns null for a missing object rather than throwing', async () => {
    // "Absent" and "lookup failed" must stay distinguishable: a session with
    // no activity file is a valid answer, a broken bucket is not.
    const s3 = { send: jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { name: 'NoSuchKey' })) };
    const service = new StorageService(s3 as never, 'screencast-sessions');
    await expect(service.getObjectText('missing.jsonl')).resolves.toBeNull();
  });

  it('rethrows a real failure instead of reporting it as absent', async () => {
    const s3 = { send: jest.fn().mockRejectedValue(Object.assign(new Error('down'), { name: 'InternalError' })) };
    const service = new StorageService(s3 as never, 'screencast-sessions');
    await expect(service.getObjectText('events.jsonl')).rejects.toThrow('down');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/storage/storage.service.spec.ts`
Expected: FAIL — `service.getObjectText is not a function`

- [ ] **Step 4: Implement**

Add to `StorageService`:

```typescript
  /**
   * Short-lived presigned GET so the browser fetches media directly.
   *
   * The API must not become the data path for video; presigning uses the
   * s3:GetObject the scoped credential already has, and needs no new
   * permission.
   */
  async presignGet(key: string, expirySeconds: number): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expirySeconds,
    });
  }

  /**
   * Reads a small text object whole. Used for events.jsonl, which is ~10 MB
   * for a four-hour session -- fine to parse in the pod, unlike video.
   */
  async getObjectText(key: string): Promise<string | null> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return (await response.Body?.transformToString()) ?? null;
    } catch (error) {
      const name = (error as { name?: string }).name;
      // Absent is an answer; anything else is a failure and must surface.
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw error;
    }
  }
```

Add imports: `GetObjectCommand` from `@aws-sdk/client-s3`, `getSignedUrl` from `@aws-sdk/s3-request-presigner`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/storage/storage.service.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/storage/storage.service.ts src/storage/storage.service.spec.ts package.json package-lock.json
git commit -m "feat(preview): presign media GETs and read small text objects"
```

---

### Task 5: PreviewService — status, timeline, render requests

**Files:**
- Create: `src/preview/preview.service.ts`
- Create: `src/preview/preview.module.ts`
- Test: `src/preview/preview.service.spec.ts`
- Modify: `src/app.module.ts` (import `PreviewModule`)

**Interfaces:**
- Consumes: `buildTimeline`, `parseSamples` (Task 1); `selectAudioSource`, `audioObjectKey`, `missingAudioProxies`, `AudioSourceView` (Task 2); `SessionPreview`, `PreviewState`, `PreviewArtifact`, `isLegalPreviewTransition` (Task 3); `StorageService.presignGet`, `StorageService.getObjectText` (Task 4); `CommandsService.queue`, `CommandType` (existing); `Session`, `Track`, `Manifest` (existing).
- Produces:
  - `PreviewService.status(sessionId: string): Promise<PreviewStatus>`
  - `PreviewService.timeline(sessionId: string, bucketCount: number): Promise<Timeline>`
  - `PreviewService.requestRender(sessionId: string): Promise<PreviewStatus>`
  - `PreviewService.videoUrl(sessionId: string): Promise<string>`
  - `PreviewService.audioUrl(sessionId: string, sourceRef: string): Promise<string>`
  - `interface PreviewStatus { sessionId: string; state: PreviewState; audioSources: AudioSourceView[]; sourcePath: 'local' | 'storage' | null; failureReason: string | null; durationMs: number | null; keysAndClicks: 'not-captured' }`

Note `requestRender` takes **no** source argument: one render produces every
source. `audioUrl` is per source because each is a separate object.

- [ ] **Step 1: Write the failing test**

```typescript
// src/preview/preview.service.spec.ts
import { NotFoundException } from '@nestjs/common';
import { PreviewService } from './preview.service';
import { PreviewState } from './session-preview.entity';
import { SessionState } from '../sessions/entities/session.entity';

const CREDENTIAL_TITLE = 'deploy hvs.CAESIJxAbCdEfGhIjKlMnOpQrStUvWxYz012345 - Cursor';

const sampleLine = (ts: number, window: string) =>
  JSON.stringify({ ts, display: 'HDMI-A-0', window, mouse: [1, 1], clicks: 0, keys: 0, hotkeys: [] });

function makeService(overrides: Partial<Record<string, unknown>> = {}) {
  const session = {
    id: 's1',
    state: SessionState.Stored,
    s3Prefix: 'sessions/2026/09/07/s1',
  };
  const sessions = { findOne: jest.fn().mockResolvedValue(session) };
  const previews = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn((r) => r), create: jest.fn((r) => r) };
  const manifests = {
    find: jest.fn().mockResolvedValue([
      { document: { hostname: 'alfares', tracks: [{ kind: 'metadata', source_ref: 'activity', segments: [] }] } },
    ]),
  };
  const storage = { getObjectText: jest.fn(), presignGet: jest.fn().mockResolvedValue('https://signed') };
  const commands = { queue: jest.fn() };
  const service = new PreviewService(
    sessions as never, previews as never, manifests as never,
    storage as never, commands as never,
  );
  return { service, sessions, previews, storage, commands, ...overrides };
}

describe('PreviewService.timeline', () => {
  it('never lets a credential-shaped window title reach the response', async () => {
    // The tracker's sanitiser runs upstream, two layers away, with nothing
    // asserting the contract between it and this endpoint. Preview is the
    // first thing that puts titles on a screen, so the boundary is pinned
    // here. This does not add redaction; it prevents the guarantee from
    // silently lapsing.
    const { service, storage } = makeService();
    storage.getObjectText.mockResolvedValue(
      [sampleLine(1000, CREDENTIAL_TITLE), sampleLine(1000.2, CREDENTIAL_TITLE)].join('\n'),
    );
    const timeline = await service.timeline('s1', 10);
    expect(JSON.stringify(timeline)).not.toMatch(/hvs\.[A-Za-z0-9]/);
  });

  it('raises rather than returning an empty timeline when the activity file is missing', async () => {
    // An empty timeline would read as "nothing happened" instead of
    // "the file could not be found".
    const { service, storage } = makeService();
    storage.getObjectText.mockResolvedValue(null);
    await expect(service.timeline('s1', 10)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PreviewService.status', () => {
  it('always reports keys and clicks as not captured', async () => {
    const { service } = makeService();
    const status = await service.status('s1');
    expect(status.keysAndClicks).toBe('not-captured');
  });
});

describe('PreviewService.requestRender', () => {
  it('queues a render-preview command for a stored session', async () => {
    const { service, commands } = makeService();
    await service.requestRender('s1');
    expect(commands.queue).toHaveBeenCalledWith(
      expect.any(String), 'render-preview', 's1', expect.objectContaining({ prefix: 'sessions/2026/09/07/s1' }),
    );
  });

  it('refuses a session that is not stored', async () => {
    const { service, sessions } = makeService();
    sessions.findOne.mockResolvedValue({ id: 's1', state: SessionState.Recording, s3Prefix: null });
    await expect(service.requestRender('s1')).rejects.toThrow(/not stored/i);
  });

  it('does not re-render a ready preview', async () => {
    const { service, previews, commands } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Ready, artifacts: [] });
    await service.requestRender('s1');
    expect(commands.queue).not.toHaveBeenCalled();
  });
});

describe('PreviewService.audioUrl', () => {
  it('presigns the proxy for the requested source', async () => {
    const { service, previews, storage } = makeService();
    previews.findOne.mockResolvedValue({
      state: PreviewState.Ready,
      artifacts: [
        { kind: 'video', sourceRef: null, objectKey: 'p/preview/proxy.mp4', bytes: 1, durationMs: 1 },
        { kind: 'audio', sourceRef: 'usb2', objectKey: 'p/preview/audio-usb2.m4a', bytes: 1, durationMs: 1 },
      ],
    });
    await service.audioUrl('s1', 'usb2');
    expect(storage.presignGet).toHaveBeenCalledWith('p/preview/audio-usb2.m4a', expect.any(Number));
  });

  it('raises for a source that has no rendered proxy rather than falling back to another', async () => {
    // Falling back to a different microphone would play the operator audio
    // from a source they did not choose, and nothing on screen would say so.
    const { service, previews } = makeService();
    previews.findOne.mockResolvedValue({
      state: PreviewState.Ready,
      artifacts: [{ kind: 'audio', sourceRef: 'usb2', objectKey: 'k', bytes: 1, durationMs: 1 }],
    });
    await expect(service.audioUrl('s1', 'jabra')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/preview/preview.service.spec.ts`
Expected: FAIL — `Cannot find module './preview.service'`

- [ ] **Step 3: Implement `PreviewService` and `PreviewModule`**

Key requirements the implementation must satisfy:
- `status` returns `keysAndClicks: 'not-captured'` **always**, as a literal — never a number, never omitted.
- `timeline` locates `events.jsonl` from the manifest's metadata track at `<prefix>/<hostname>/metadata/events.jsonl`, reads it via `storage.getObjectText`, and throws `NotFoundException` when it is absent — never returns an empty timeline for a missing file.
- `timeline` handles a **multi-host session**: iterate every manifest, concatenate their samples, and sort by `ts` (`parseSamples` already sorts). Do not hardcode a single manifest.
- `requestRender` throws `BadRequestException` unless `session.state === SessionState.Stored`, and returns early without queueing when a `ready` row already exists. It takes **no** source argument — one render produces every source, so switching source later never queues a second render.
- `requestRender` resolves the agent id from the manifest's `agent_id`, and passes `{ prefix, audioSourceRefs, previewId }` as the command payload, where `audioSourceRefs` is every audio track's `source_ref` from the manifests.
- `status` derives `audioSources` from the manifest's audio tracks joined with the levels the agent reported, via `selectAudioSource`. Every source appears, whether or not it carried signal.
- `videoUrl` and `audioUrl` throw `NotFoundException` when the preview is not `ready` or the requested artifact is absent — never silently regenerate, and **never fall back to a different source**: playing audio from a microphone the operator did not choose, with nothing on screen saying so, is exactly the silent substitution this design forbids.
- Register `PreviewModule` in `src/app.module.ts`, importing `TypeOrmModule.forFeature([Session, Manifest, SessionPreview])`, `StorageModule`, `SessionsModule`, `AuthModule`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/preview/preview.service.spec.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/preview/preview.service.ts src/preview/preview.module.ts src/preview/preview.service.spec.ts src/app.module.ts
git commit -m "feat(preview): serve preview status, timeline and render requests"
```

---

### Task 6: PreviewController — operator-lane routes

**Files:**
- Create: `src/preview/preview.controller.ts`
- Test: `src/preview/preview.controller.spec.ts`
- Modify: `src/preview/preview.module.ts` (register the controller)

**Interfaces:**
- Consumes: `PreviewService` (Task 5).
- Produces: routes `GET /api/sessions/:id/preview`, `POST /api/sessions/:id/preview`, `GET /api/sessions/:id/preview/media`, `GET /api/sessions/:id/preview/audio/:sourceRef`, `GET /api/sessions/:id/timeline`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/preview/preview.controller.spec.ts
import { AGENT_ROUTE } from '../auth/agent-roles.decorator';
import { PUBLIC_ROUTE } from '../auth/public.decorator';
import { PreviewController } from './preview.controller';

describe('PreviewController lanes', () => {
  it('marks no preview route as an agent route or as public', () => {
    // Preview is the operator lane. An @AgentRoute() here would let the
    // machine credential read an operator's session; a @Public() would let
    // anyone. The global UserAuthGuard is the only thing that should cover it.
    const methods = ['status', 'requestRender', 'media', 'audio', 'timeline'] as const;
    for (const method of methods) {
      const handler = PreviewController.prototype[method];
      expect(Reflect.getMetadata(AGENT_ROUTE, handler)).toBeUndefined();
      expect(Reflect.getMetadata(PUBLIC_ROUTE, handler)).toBeUndefined();
    }
  });
});

describe('PreviewController.media', () => {
  it('redirects to the presigned url rather than proxying the bytes', async () => {
    // The API is the control plane, not the video data path.
    const service = { videoUrl: jest.fn().mockResolvedValue('https://signed') };
    const controller = new PreviewController(service as never);
    const res = { redirect: jest.fn() };
    await controller.media('s1', res as never);
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://signed');
  });
});

describe('PreviewController.audio', () => {
  it('redirects to the presigned url for the named source', async () => {
    const service = { audioUrl: jest.fn().mockResolvedValue('https://signed-audio') };
    const controller = new PreviewController(service as never);
    const res = { redirect: jest.fn() };
    await controller.audio('s1', 'usb2', res as never);
    expect(service.audioUrl).toHaveBeenCalledWith('s1', 'usb2');
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://signed-audio');
  });
});
```

The metadata key names are `AGENT_ROUTE` (`'agent_route'`) and `PUBLIC_ROUTE` (`'public_route'`), verified in `src/auth/agent-roles.decorator.ts` and `src/auth/public.decorator.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/preview/preview.controller.spec.ts`
Expected: FAIL — `Cannot find module './preview.controller'`

- [ ] **Step 3: Implement the controller**

```typescript
// src/preview/preview.controller.ts
import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PreviewService } from './preview.service';

/** Default bucket count: roughly one per horizontal pixel of the timeline. */
const DEFAULT_BUCKETS = 1000;

/**
 * Operator-lane preview routes.
 *
 * Deliberately carries neither @AgentRoute() nor @Public(): the global
 * UserAuthGuard covers these, and preview is an operator feature. The agent's
 * only involvement is the render-preview command it receives on its own
 * authenticated channel.
 */
@Controller('api/sessions')
export class PreviewController {
  constructor(private readonly preview: PreviewService) {}

  @Get(':id/preview')
  status(@Param('id', ParseUUIDPipe) id: string) {
    return this.preview.status(id);
  }

  /** No source parameter: one render produces every audio source. */
  @Post(':id/preview')
  requestRender(@Param('id', ParseUUIDPipe) id: string) {
    return this.preview.requestRender(id);
  }

  /**
   * Redirects rather than streaming: the API must not become the data path
   * for video, and a redirect lets the browser's Range requests reach MinIO
   * directly, which is what makes seeking work.
   */
  @Get(':id/preview/media')
  async media(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    res.redirect(302, await this.preview.videoUrl(id));
  }

  /**
   * One audio proxy per source, each separately addressable.
   *
   * Separate objects rather than extra streams in the video: a browser plays
   * only the first audio track of a <video> and exposes no switcher, so
   * muxing would leave every source but one unreachable.
   */
  @Get(':id/preview/audio/:sourceRef')
  async audio(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sourceRef') sourceRef: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.preview.audioUrl(id, sourceRef));
  }

  @Get(':id/timeline')
  timeline(@Param('id', ParseUUIDPipe) id: string, @Query('buckets') buckets?: string) {
    const count = Number(buckets) > 0 ? Math.min(5000, Number(buckets)) : DEFAULT_BUCKETS;
    return this.preview.timeline(id, count);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/preview/preview.controller.spec.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/preview/preview.controller.ts src/preview/preview.controller.spec.ts src/preview/preview.module.ts
git commit -m "feat(preview): expose operator-lane preview routes"
```

---

### Task 7: Agent-side proxy renderer

**Files:**
- Create: `agent/src/preview/render.ts`
- Test: `agent/src/preview/render.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the agent is a separate build).
- Produces:
  - `function buildVideoProxyArgs(concatListPath: string, outPath: string): string[]`
  - `function buildAudioProxyArgs(concatListPath: string, outPath: string): string[]`
  - `function buildVolumedetectArgs(concatListPath: string): string[]`
  - `function buildConcatList(paths: string[]): string`
  - `const VAAPI_DEVICE = '/dev/dri/renderD128'`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/preview/render.spec.ts
import {
  buildAudioProxyArgs,
  buildConcatList,
  buildVideoProxyArgs,
  buildVolumedetectArgs,
} from './render';

describe('buildVideoProxyArgs', () => {
  const args = buildVideoProxyArgs('/v.txt', '/out.mp4');

  it('puts moov at the front, which is what makes seeking work', () => {
    // Without faststart the browser must download the whole file before it
    // can show a frame or seek -- exactly the trap the raw segments fall into.
    expect(args).toContain('-movflags');
    expect(args).toContain('+faststart');
  });

  it('scales to 960x540 at 10fps, legible enough to find a moment', () => {
    expect(args.join(' ')).toContain('scale=960:540');
    expect(args).toContain('-r');
    expect(args).toContain('10');
  });

  it('uses the VAAPI encoder on the render node', () => {
    expect(args).toContain('h264_vaapi');
    expect(args).toContain('/dev/dri/renderD128');
  });

  it('carries no audio stream at all', () => {
    // Audio lives in separate per-source files. Muxing even one stream here
    // would make that source the only reachable one, because a browser plays
    // only the first audio track of a <video> and exposes no switcher.
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
  });
});

describe('buildAudioProxyArgs', () => {
  const args = buildAudioProxyArgs('/a.txt', '/out.m4a');

  it('encodes speech at 24k mono 22.05kHz, intelligible rather than pretty', () => {
    // Three tracks at 64k would outweigh the video four to one. This is a
    // preview for judging what was captured, not a listening copy.
    expect(args).toContain('24k');
    expect(args.join(' ')).toContain('-ac 1');
    expect(args).toContain('22050');
  });

  it('carries no video stream', () => {
    expect(args).toContain('-vn');
  });

  it('is faststart too, so seeking the audio does not download it whole', () => {
    expect(args).toContain('+faststart');
  });
});

describe('buildConcatList', () => {
  it('emits one ffmpeg concat entry per segment', () => {
    expect(buildConcatList(['/a/seg-00000.mp4', '/a/seg-00001.mp4'])).toBe(
      "file '/a/seg-00000.mp4'\nfile '/a/seg-00001.mp4'\n",
    );
  });
});

describe('buildVolumedetectArgs', () => {
  it('measures a source without writing any output file', () => {
    const args = buildVolumedetectArgs('/a.txt');
    expect(args).toContain('volumedetect');
    expect(args.slice(-1)[0]).toBe('-');
    expect(args).toContain('null');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest agent/src/preview/render.spec.ts`
Expected: FAIL — `Cannot find module './render'`

- [ ] **Step 3: Implement**

```typescript
// agent/src/preview/render.ts

/**
 * Builds the ffmpeg invocations for a preview render.
 *
 * Rendering runs here rather than in the API because the API pod has 500m of
 * CPU, no /dev/dri and no ffmpeg binary: software-only rendering there measured
 * ~98-123 minutes for a four-hour session while also serving the console. This
 * host has the GPU, 24 cores and the files.
 *
 * A render produces a SILENT video proxy plus one audio proxy per capture
 * source. The split exists because a browser plays only the first audio track
 * of a <video> element and exposes no switcher, so muxing would leave every
 * source but one permanently unreachable -- and the owner uses different
 * headsets across sessions, so which source carried signal varies.
 *
 * Measured, the split is also cheaper than muxing: ~86.7 MB of video plus
 * ~54.0 MB for three audio sources over four hours, against ~211 MB for the
 * single muxed file it replaces.
 *
 * Argument construction is separated from execution so the flags that matter --
 * faststart above all -- are testable without spawning ffmpeg.
 */

export const VAAPI_DEVICE = '/dev/dri/renderD128';

export function buildConcatList(paths: string[]): string {
  return paths.map((path) => `file '${path}'\n`).join('');
}

/** The screen proxy. Deliberately silent: audio ships as separate files. */
export function buildVideoProxyArgs(concatListPath: string, outPath: string): string[] {
  return [
    '-y', '-loglevel', 'error',
    '-vaapi_device', VAAPI_DEVICE,
    '-f', 'concat', '-safe', '0', '-i', concatListPath,
    '-an',
    '-vf', 'scale=960:540,format=nv12,hwupload',
    '-c:v', 'h264_vaapi', '-qp', '32', '-r', '10',
    // The whole point: moov at the front, so the browser can seek without
    // downloading the file.
    '-movflags', '+faststart',
    outPath,
  ];
}

/**
 * One source's audio proxy.
 *
 * 24 kbps mono at 22.05 kHz: speech stays intelligible, and intelligibility is
 * the entire requirement here. At 64 kbps three sources would outweigh the
 * video four to one.
 */
export function buildAudioProxyArgs(concatListPath: string, outPath: string): string[] {
  return [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', concatListPath,
    '-vn',
    '-c:a', 'aac', '-b:a', '24k', '-ac', '1', '-ar', '22050',
    '-movflags', '+faststart',
    outPath,
  ];
}

/** Measures a source's level without producing an output file. */
export function buildVolumedetectArgs(concatListPath: string): string[] {
  return [
    '-v', 'info',
    '-f', 'concat', '-safe', '0', '-i', concatListPath,
    '-af', 'volumedetect', '-f', 'null', '-',
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest agent/src/preview/render.spec.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add agent/src/preview/render.ts agent/src/preview/render.spec.ts
git commit -m "feat(agent): build the preview proxy ffmpeg invocations"
```

---

### Task 8: Agent `render-preview` command handling, with contention refusal

This is the task that touches the agent, the component holding the only copy of an unrepeatable recording. The contention rule is the point of it.

**Files:**
- Modify: `agent/src/agent.ts` — add `'render-preview'` to `Command['type']`, add `renderPreview()`, extend `AgentDeps.capture` with `renderPreview`
- Test: `agent/src/agent.spec.ts`
- Modify: `agent/src/main.ts` — wire the real `renderPreview` implementation
- Modify: `src/sessions/entities/command.entity.ts` — add `RenderPreview = 'render-preview'` to `CommandType`

**Interfaces:**
- Consumes: `buildVideoProxyArgs`, `buildAudioProxyArgs`, `buildConcatList`, `buildVolumedetectArgs` (Task 7).
- Produces:
  - `interface RenderedArtifact { kind: 'video' | 'audio'; sourceRef: string | null; objectKey: string; bytes: number; durationMs: number | null; meanDb?: number; maxDb?: number }`
  - `AgentDeps.capture.renderPreview(sessionId: string, prefix: string, audioSourceRefs: string[]): Promise<{ artifacts: RenderedArtifact[]; sourcePath: 'local' | 'storage' }>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to agent/src/agent.spec.ts
describe('render-preview', () => {
  const command = {
    command_id: 'c1',
    type: 'render-preview' as const,
    session_id: 's1',
    payload: {
      prefix: 'sessions/2026/09/07/s1',
      audioSourceRefs: ['jabra', 'usb1', 'usb2'],
    },
  };

  const artifacts = [
    { kind: 'video', sourceRef: null, objectKey: 'p/preview/proxy.mp4', bytes: 529020, durationMs: 87837 },
    { kind: 'audio', sourceRef: 'jabra', objectKey: 'p/preview/audio-jabra.m4a', bytes: 23487, durationMs: 87830, meanDb: -91, maxDb: -91 },
    { kind: 'audio', sourceRef: 'usb1', objectKey: 'p/preview/audio-usb1.m4a', bytes: 24087, durationMs: 87884, meanDb: -91, maxDb: -91 },
    { kind: 'audio', sourceRef: 'usb2', objectKey: 'p/preview/audio-usb2.m4a', bytes: 282122, durationMs: 87883, meanDb: -57.2, maxDb: -20.3 },
  ];

  it('refuses to render while a recording is running', async () => {
    // A recording is unrepeatable; a render is always repeatable. When they
    // contend for GPU and disk, the render loses -- and that priority is
    // enforced here rather than left to timing.
    const deps = makeDeps({ isRunning: () => true });
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle(command);

    expect(deps.capture.renderPreview).not.toHaveBeenCalled();
    expect(deps.api.post).toHaveBeenCalledWith(
      '/api/sessions/s1/preview-complete',
      expect.objectContaining({ state: 'deferred', reason: 'capture_running' }),
    );
  });

  it('renders every audio source, not only the loudest', async () => {
    // The owner uses different headsets across sessions, so which source
    // carried signal varies. Rendering one would leave the right microphone
    // unreachable, and it would fail silently -- a preview that plays some
    // audio looks like it is working.
    const deps = makeDeps({ isRunning: () => false });
    deps.capture.renderPreview.mockResolvedValue({ artifacts, sourcePath: 'local' });
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle(command);

    expect(deps.capture.renderPreview).toHaveBeenCalledWith(
      's1', 'sessions/2026/09/07/s1', ['jabra', 'usb1', 'usb2'],
    );
    const posted = deps.api.post.mock.calls.at(-1)[1];
    expect(posted.artifacts.filter((a: { kind: string }) => a.kind === 'audio')).toHaveLength(3);
  });

  it('reports which source path it read from', async () => {
    const deps = makeDeps({ isRunning: () => false });
    deps.capture.renderPreview.mockResolvedValue({ artifacts, sourcePath: 'storage' });
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle(command);

    expect(deps.api.post).toHaveBeenCalledWith(
      '/api/sessions/s1/preview-complete',
      expect.objectContaining({ state: 'ready', source_path: 'storage' }),
    );
  });

  it('reports a failed render without touching anything else', async () => {
    const deps = makeDeps({ isRunning: () => false });
    deps.capture.renderPreview.mockRejectedValue(new Error('ffmpeg died'));
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle(command);

    expect(deps.api.post).toHaveBeenCalledWith(
      '/api/sessions/s1/preview-complete',
      expect.objectContaining({ state: 'failed', reason: 'render_failed' }),
    );
  });
});
```

Reuse the existing `makeDeps` helper in `agent.spec.ts`; extend it with a `renderPreview: jest.fn()` on `capture` and an `isRunning` override.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest agent/src/agent.spec.ts`
Expected: FAIL — the `render-preview` case falls through the switch and posts nothing

- [ ] **Step 3: Implement**

Add to `agent/src/agent.ts`:

```typescript
  /**
   * Renders the preview set: a silent video proxy plus one audio proxy per
   * capture source.
   *
   * Never runs while capture is live. A recording cannot be repeated and a
   * render always can, so on contention the render defers -- and the API is
   * told, so the operator sees "waiting for the recording to finish" instead
   * of a request that vanished.
   *
   * Every audio source is rendered, not just the loudest: the owner uses
   * different headsets across sessions, so picking one would sometimes strand
   * the microphone that actually captured the commentary.
   *
   * Strictly read-only on session media: it writes only new objects under
   * preview/ and has no delete path anywhere.
   */
  private async renderPreview(command: Command): Promise<void> {
    if (this.deps.capture.isRunning()) {
      await this.reportPreview(command.session_id, {
        state: 'deferred',
        reason: 'capture_running',
      });
      return;
    }

    const prefix = command.payload.prefix as string | undefined;
    if (!prefix) {
      await this.reportPreview(command.session_id, { state: 'failed', reason: 'no_prefix' });
      return;
    }

    try {
      const result = await this.deps.capture.renderPreview(
        command.session_id,
        prefix,
        (command.payload.audioSourceRefs as string[] | undefined) ?? [],
      );
      await this.reportPreview(command.session_id, {
        state: 'ready',
        artifacts: result.artifacts,
        source_path: result.sourcePath,
      });
    } catch (error) {
      // Inert failure: nothing was modified, so a retry is always safe.
      // A partial set is a failure, never a ready preview -- objects already
      // written stay put (nothing is deleted) and a retry overwrites them.
      await this.reportPreview(command.session_id, {
        state: 'failed',
        reason: 'render_failed',
        detail: (error as Error).message,
      });
    }
  }

  private async reportPreview(sessionId: string, body: Record<string, unknown>): Promise<void> {
    const path = `/api/sessions/${sessionId}/preview-complete`;
    const payload = { agent_id: this.config.agentId, ...body };
    try {
      await this.deps.api.post(path, payload);
    } catch (error) {
      await this.handleApiFailure(error);
      this.pending.push({ path, body: payload });
    }
  }
```

Add `case 'render-preview': return this.renderPreview(command);` to the switch in `handle`, and `'render-preview'` to the `Command['type']` union.

In `agent/src/main.ts`, implement `capture.renderPreview` to:

1. Locate segments locally under `config.recordingDir/<sessionId>`, and **fall back to downloading from MinIO** when absent, reporting `sourcePath` as `'local'` or `'storage'` accordingly.
2. Render the video proxy with `buildVideoProxyArgs` → `<prefix>/preview/proxy.mp4`.
3. For **each** entry in `audioSourceRefs`: run `buildVolumedetectArgs` to measure its level, then `buildAudioProxyArgs` → `<prefix>/preview/audio-<slug>.m4a`. Use the same slugging as `audioObjectKey` in Task 2 so the API and agent agree on keys.
4. Upload every produced file via the existing `Uploader`, and return one `RenderedArtifact` per object, carrying the measured `meanDb`/`maxDb` for each audio source.
5. Report progress per output — the video proxy, then each audio source by name — so a multi-source render does not look stalled while it works through the audio.

**If any audio source fails to render, the whole render fails.** A partial set must never be reported ready: the missing source is exactly the one the operator would have needed, and silently offering the rest reproduces the failure this design exists to prevent.

**The local/MinIO fallback exists because local files may be gone by the time someone looks at a session**, for reasons preview does not control and does not participate in. Without it, preview would fail exactly on older sessions — the case where "what is in this?" is hardest to answer from memory. The two paths have very different waits (a four-hour session pulls ~1.6 GB over the network on the storage path), which is why `sourcePath` is reported rather than inferred.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest agent/src/agent.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/agent.ts agent/src/agent.spec.ts agent/src/main.ts src/sessions/entities/command.entity.ts
git commit -m "feat(agent): render preview proxies, never while capture runs"
```

---

### Task 9: `preview-complete` callback

**Files:**
- Modify: `src/sessions/sessions.controller.ts` — add the agent-lane route
- Create: `src/preview/dto/preview.dto.ts`
- Modify: `src/preview/preview.service.ts` — add `completeRender`
- Test: `src/preview/preview.service.spec.ts`

**Interfaces:**
- Consumes: `SessionPreview`, `PreviewState`, `PreviewArtifact`, `isLegalPreviewTransition` (Task 3); `missingAudioProxies` (Task 2).
- Produces: `PreviewService.completeRender(sessionId: string, dto: PreviewCompleteDto): Promise<void>`; route `POST /api/sessions/:id/preview-complete` carrying `@AgentRoute()` + `AgentRoleGuard`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/preview/preview.service.spec.ts
const readyArtifacts = [
  { kind: 'video', sourceRef: null, objectKey: 'p/preview/proxy.mp4', bytes: 529020, durationMs: 87837 },
  { kind: 'audio', sourceRef: 'jabra', objectKey: 'p/preview/audio-jabra.m4a', bytes: 23487, durationMs: 87830 },
  { kind: 'audio', sourceRef: 'usb1', objectKey: 'p/preview/audio-usb1.m4a', bytes: 24087, durationMs: 87884 },
  { kind: 'audio', sourceRef: 'usb2', objectKey: 'p/preview/audio-usb2.m4a', bytes: 282122, durationMs: 87883 },
];

describe('PreviewService.completeRender', () => {
  it('marks a complete set ready and records which path it came from', async () => {
    const { service, previews } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Rendering, artifacts: [] });
    await service.completeRender('s1', {
      agent_id: 'a1', state: 'ready', artifacts: readyArtifacts, source_path: 'local',
    } as never);
    expect(previews.save).toHaveBeenCalledWith(
      expect.objectContaining({ state: PreviewState.Ready, sourcePath: 'local' }),
    );
  });

  it('refuses to mark ready when an audio source has no proxy', async () => {
    // Three sources with two proxies is an incomplete preview. The missing
    // one is exactly the microphone the operator would have needed, and
    // offering the other two silently is the failure this design prevents.
    const { service, previews } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Rendering, artifacts: [] });
    await service.completeRender('s1', {
      agent_id: 'a1', state: 'ready', source_path: 'local',
      artifacts: readyArtifacts.filter((a) => a.sourceRef !== 'usb1'),
    } as never);
    expect(previews.save).toHaveBeenCalledWith(
      expect.objectContaining({
        state: PreviewState.Failed,
        failureReason: expect.stringContaining('usb1'),
      }),
    );
  });

  it('records a failure reason instead of leaving the row rendering forever', async () => {
    const { service, previews } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Rendering, artifacts: [] });
    await service.completeRender('s1', {
      agent_id: 'a1', state: 'failed', reason: 'render_failed', detail: 'ffmpeg died',
    } as never);
    expect(previews.save).toHaveBeenCalledWith(
      expect.objectContaining({ state: PreviewState.Failed, failureReason: expect.stringContaining('ffmpeg died') }),
    );
  });

  it('keeps a deferred render pending so the operator can retry after recording', async () => {
    const { service, previews } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Rendering, artifacts: [] });
    await service.completeRender('s1', {
      agent_id: 'a1', state: 'deferred', reason: 'capture_running',
    } as never);
    expect(previews.save).toHaveBeenCalledWith(
      expect.objectContaining({ state: PreviewState.Pending }),
    );
  });
});
```

The `makeService` helper's `manifests.find` mock must be extended for these
cases to return the three audio tracks (`jabra`, `usb1`, `usb2`), since
completeness is checked against the manifest's audio track list.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/preview/preview.service.spec.ts`
Expected: FAIL — `service.completeRender is not a function`

- [ ] **Step 3: Implement the DTO, the service method and the route**

The DTO validates `agent_id` (UUID), `state` (`IsIn(['ready','failed','deferred'])`), an optional nested-validated `artifacts` array (`kind` in `['video','audio']`, `source_ref`, `object_key`, `bytes`, `duration_ms`, optional `mean_db`/`max_db`), and optional `source_path`, `reason`, `detail`.

`completeRender` must **verify completeness before accepting `ready`**: use `missingAudioProxies` against the manifest's audio track list, and if anything is missing, save `failed` with a reason naming the absent sources rather than `ready`. An agent claiming success is not evidence — the same principle `ManifestService.completeUpload` already applies to uploads, where `dto.verified` is deliberately not trusted.

The route goes on `SessionsController` beside the other machine routes, carrying `@AgentRoute()` and `@UseGuards(AgentRoleGuard)` — it is the agent reporting back, so it belongs in the machine lane, unlike every other preview route.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/preview/preview.service.spec.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/preview/dto/preview.dto.ts src/preview/preview.service.ts src/preview/preview.service.spec.ts src/sessions/sessions.controller.ts
git commit -m "feat(preview): accept the agent's render-complete callback"
```

---

### Task 10: Preview screen in the operator console

**Files:**
- Modify: `public/index.html` — add the `screen-preview` section and a nav entry
- Modify: `public/app.js` — add the preview screen
- Modify: `public/style.css` — timeline, sources panel, render-progress styles

**Interfaces:**
- Consumes: `GET/POST /api/sessions/:id/preview`, `GET /api/sessions/:id/preview/media`, `GET /api/sessions/:id/preview/audio/:sourceRef`, `GET /api/sessions/:id/timeline` (Tasks 5, 6).
- Produces: `openPreview(sessionId)` in `app.js`, reachable from a sessions-list row.

- [ ] **Step 1: Add the markup**

Add to `public/index.html` a `<section id="screen-preview" hidden>` containing: a `<video id="preview-video" controls preload="metadata">`, a `<div id="preview-audio-elements">` (one `<audio preload="metadata">` per source, created at runtime), a `<div id="preview-render-note">`, a `<div id="preview-sources">`, a `<canvas id="preview-timeline">`, a `<div id="preview-legend">`, and a `<p id="preview-activity-note">`.

Note: neither the `<video>` nor any `<audio>` element may carry a `crossorigin` attribute — adding one would require bucket CORS that is deliberately not configured.

- [ ] **Step 2: Implement the preview screen in `app.js`**

Requirements:
- `openPreview(sessionId)` fetches status and timeline in parallel; the **timeline renders immediately without waiting for the proxy**, because it comes from a text file that needs no rendering. Making the operator wait ~7 minutes to see which windows they were in would be an artificial delay.
- If the status is not `ready`, POST to request a render and poll status, showing the path-specific wait: `'Rendering from local files — about 7 minutes'` for `local`, `'Fetching 1.6 GB from storage, then rendering — about 20 minutes'` for `storage`. A silent thirty-times-longer render reads as a hang. The render request takes **no** source argument — one render produces every source.
- If the status is `deferred`/`pending` with `capture_running`, show `'Waiting for the current recording to finish.'`
- **Audio playback**: create one `<audio>` element per source, each pointing at `/api/sessions/:id/preview/audio/:sourceRef`. The video proxy is silent, so exactly one audio element is unmuted and playing at a time; the rest stay paused. Keep them in sync by setting `audio.currentTime = video.currentTime` on `play`, `seeked`, `ratechange` and on every source switch, and correcting whenever `Math.abs(audio.currentTime - video.currentTime) > 0.3`. The real tracks differ in length by tens of milliseconds (87.830s / 87.883s / 87.884s against 87.867s of video), so drift is real and accumulates.
- **Switching source must never reload or reposition the video** — swap which audio element plays and seek only that element. This is the whole reason audio is separate files, so verify it by switching mid-playback and confirming the video does not stall or restart.
- The sources panel lists every audio source with its measured level, marks the playing one with its reason verbatim from the API, and labels a silent source as `'digital silence — this device was probably not the active input'`. It must **not** imply a silent track is defective; add the note that all offered sources were reported available by the agent, which is correct behaviour. Every source is selectable, including the silent ones — that is how the operator confirms which microphone actually worked.
- The timeline canvas draws two lanes: window focus (top-8 colours plus one neutral "other") and mouse movement density. Clicking anywhere seeks `preview-video` to that offset, and the active audio element follows.
- `preview-activity-note` reads exactly: `'Keystroke and click density not captured — see the tracker defect in TASKS.md.'` Draw **no** keys/clicks lane, no zero bar, no flat line.
- Add a "Preview" control to each `stored` row in `loadSessions()`.

- [ ] **Step 3: Verify by hand against the deployed service**

Open `https://screencast.alfares.cz/console`, preview session `d5b209c3-d822-4d22-840b-b05f9b1384b5`, and confirm: the timeline appears before the video is ready; the focus lane shows the six real windows; the sources panel lists **all three** audio sources, two labelled digital silence at -91.0 dB and one at -20.3 dB peak marked as playing; the video plays with audio from that source; **switching to a silent source keeps the video playing without reload** and produces silence rather than an error; seeking to a late offset works and the audio follows; and no keys/clicks lane is drawn.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat(preview): add the operator preview screen"
```

---

### Task 11: Full verification against the real system

Every bug of consequence in this project was found by running the deployed thing, not by reading code or passing tests.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: typecheck, build and jest all pass; suite count above the 174/23 baseline with no skips introduced.

- [ ] **Step 2: Verify CORS and Range empirically**

Fetch a presigned URL from `GET /api/sessions/:id/preview/media`, then confirm the object answers `Accept-Ranges: bytes` and returns `206 Partial Content` for `Range: bytes=0-102399`. Do the same for one `GET /api/sessions/:id/preview/audio/:sourceRef`. Confirm the `<video>` and `<audio>` elements play and seek in a real browser.

**If bucket CORS configuration turns out to be genuinely required, STOP and raise it. Do not configure the bucket.**

- [ ] **Step 3: Verify every audio source is reachable and correct**

For the reference session, confirm all three audio proxies exist in MinIO, that each plays from the console, and that the one carrying signal is audible while the two silent ones are genuinely silent rather than erroring. Then confirm the completeness rule by inspecting a preview whose artifact set is short a source — it must read `failed` with the missing source named, never `ready`.

- [ ] **Step 4: Record a fresh session and preview it end to end**

Record a short session through the console, save it, then preview it. Confirm the video proxy and every audio proxy render, the timeline matches what was actually done, and the window titles are the real ones.

- [ ] **Step 4: Verify the contention rule live**

Start a recording, request a preview render of an *older* stored session while it runs, and confirm the render defers rather than competing with capture, and that the console says so.

- [ ] **Step 5: Confirm nothing was deleted**

Verify local session directories and all MinIO objects are intact, and that the only new objects are `preview/proxy.mp4` and one `preview/audio-<slug>.m4a` per source.

- [ ] **Step 6: Verify the deploy by pod image and age**

```bash
kubectl -n statex-apps get pods -l app=screencast-recorder -o wide
kubectl -n statex-apps get deploy screencast-recorder \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

This repo has had a crash-looping pod sit behind a healthy old one more than once. Check the image tag matches the commit and the age matches the deploy — not the deploy banner.

- [ ] **Step 7: Update status files**

Move the preview item from "Ready next" to "Completed" in `TASKS.md`, leaving the tracker defect in "Active" (it is not fixed by this work). Update `STATE.json` `delivery` and `planning`. Record validation evidence under `docs/12_validation/`.

- [ ] **Step 8: Commit**

```bash
git add TASKS.md STATE.json docs/12_validation/
git commit -m "docs: record session preview validation evidence"
```

---

## Self-Review

**Spec coverage.** Agent-side rendering with the three containments → Tasks 7, 8. Local-then-MinIO fallback with its reasoning → Task 8. Every audio source reachable, separate files, 24 kbps → Tasks 2, 7, 8, 10. Levels panel with silence labelled and every source selectable → Tasks 2, 5, 10. Completeness enforced, never a partial ready → Tasks 2, 8, 9, 11. Sync without video reload → Task 10. Three-lane timeline with keys/clicks omitted → Tasks 1, 5, 10. Top-8 title palette → Tasks 1, 10. Server-side bucketing → Tasks 1, 5. Sanitiser boundary test → Task 5. Render lifecycle and two distinguishable waits → Tasks 3, 8, 9, 10. New screen with stable URL and operator-lane routes → Tasks 6, 10. Presigning without new permissions, CORS verified not assumed → Tasks 4, 11. Corrected figures → the spec's table and Task 7's comment. No deletion anywhere.

**Type consistency.** `PreviewState`, `PreviewArtifact` and `isLegalPreviewTransition` (Task 3) are used identically in Tasks 5 and 9. `AudioSourceView`/`AudioSourceLevel`, `audioObjectKey` and `missingAudioProxies` (Task 2) flow into `PreviewStatus` and completeness checking (Tasks 5, 9) and the panel (Task 10). `Timeline`/`TimelineBucket`/`FocusInterval` (Task 1) are consumed unchanged by Tasks 5 and 10. `renderPreview`'s return shape (Task 8) — `{ artifacts: RenderedArtifact[]; sourcePath }` — matches the `preview-complete` DTO's `artifacts`/`source_path` (Task 9) and the entity's `artifacts` jsonb (Task 3), field for field: `kind`, `sourceRef`/`source_ref`, `objectKey`/`object_key`, `bytes`, `durationMs`/`duration_ms`. The agent's slugging (Task 8, step 3) is specified to match `audioObjectKey` (Task 2) so both sides derive identical keys.

**Placeholder scan.** No TBDs. Task 5's and Task 10's implementation steps state requirements rather than full listings — deliberate, because the service wiring and the canvas drawing are long and mechanical, and every type, route, literal string and behavioural rule they must satisfy is given exactly. The tests that gate them are written out in full.

**Verified rather than assumed.** Task 6's metadata key names were confirmed against the source: `AGENT_ROUTE` and `PUBLIC_ROUTE`.
