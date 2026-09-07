# Session Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator see what a stored session contains — the screen video, its audio, and a timeline of window focus and mouse movement — before deciding whether to keep it.

**Architecture:** The agent renders one low-resolution faststart proxy per session per audio source, because it has the GPU, 24 cores and the files while the API pod has 500m CPU, no `/dev/dri` and no ffmpeg. The API presigns a GET for that proxy and separately parses `events.jsonl` into ~1000 buckets server-side. The browser plays a plain `<video>` (Range requests give seeking for free) beside a timeline canvas.

**Tech Stack:** NestJS 10, TypeORM 0.3, Postgres, `@aws-sdk/client-s3` (+ `@aws-sdk/s3-request-presigner`), ffmpeg/VAAPI on the agent, framework-free vanilla JS frontend, Jest + ts-jest.

**Spec:** [`docs/superpowers/specs/2026-09-07-session-preview-design.md`](../specs/2026-09-07-session-preview-design.md)

## Global Constraints

- **Preview routes are the OPERATOR lane.** No `@AgentRoute()`, no `@Public()`. The global `UserAuthGuard` covers them. The `render-preview` command travels the existing agent long-poll channel.
- **Never weaken the storage boundary.** No public bucket policy, no root credential, no widening the scoped policy beyond `screencast-sessions`. Presigning uses the already-granted `s3:GetObject`. If bucket CORS turns out to be genuinely required, **stop and raise it** — do not configure the bucket.
- **Delete nothing.** No local media, no objects, no rows. No code path in this work may delete. Preview is not a gate on retention and authorises no deletion.
- **Keys and clicks must never render as a zero value, a flat line, or an empty bar.** They are omitted with a note pointing at the defect in `TASKS.md`.
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

### Task 2: Audio source selection by measured level (pure module)

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

- [ ] **Step 1: Write the failing test**

```typescript
// src/preview/audio-selection.spec.ts
import { parseVolumedetect, selectAudioSource } from './audio-selection';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/preview/audio-selection.spec.ts`
Expected: FAIL — `Cannot find module './audio-selection'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/preview/audio-selection.ts

/**
 * Chooses which audio source the preview proxy carries.
 *
 * The proxy carries one stream because a browser plays only the first audio
 * track in a <video> element and exposes no switcher, so extra streams would
 * be unreachable.
 *
 * "Loudest wins" is a heuristic and it can pick wrong: a quiet, correct
 * microphone alongside a louder ambient source is the owner's intended use,
 * not an exotic edge. That is why the operator override exists and why every
 * source's level is shown rather than only the winner's -- a wrong pick is
 * visible and costs a click, instead of producing a silently misleading
 * preview.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/preview/audio-selection.spec.ts`
Expected: PASS, 5 tests

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
  - `class SessionPreview` with `id`, `sessionId`, `audioSourceRef` (`string | null`), `state`, `objectKey` (`string | null`), `bytes` (`string`), `durationMs` (`number | null`), `sourcePath` (`'local' | 'storage' | null`), `failureReason` (`string | null`), `requestedAt`, `readyAt`
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

/**
 * One rendered proxy, per session per audio source.
 *
 * Keyed by audio source because the operator can override the automatic pick,
 * and a re-render for a different microphone is cached beside the first rather
 * than replacing it -- a wrong pick then costs a click, not a re-render wait.
 */
@Entity('session_previews')
@Index(['sessionId', 'audioSourceRef'], { unique: true })
export class SessionPreview {
  @PrimaryColumn({ type: 'uuid' })
  id: string = randomUUID();

  @Column({ type: 'uuid' })
  sessionId!: string;

  /** Null when the session has no audio track at all. */
  @Column({ type: 'text', nullable: true })
  audioSourceRef!: string | null;

  @Column({ type: 'text', default: PreviewState.Pending })
  state!: PreviewState;

  @Column({ type: 'text', nullable: true })
  objectKey!: string | null;

  @Column({ type: 'bigint', default: 0 })
  bytes!: string;

  @Column({ type: 'integer', nullable: true })
  durationMs!: number | null;

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
 * Rendered preview proxies, one row per session per audio source.
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
        "audioSourceRef" text,
        "state" text NOT NULL DEFAULT 'pending',
        "objectKey" text,
        "bytes" bigint NOT NULL DEFAULT 0,
        "durationMs" integer,
        "sourcePath" text,
        "failureReason" text,
        "requestedAt" timestamptz NOT NULL DEFAULT now(),
        "readyAt" timestamptz
      )
    `);
    // One proxy per session per audio source; a repeat request reuses the row.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_session_previews_session_source"
      ON "session_previews" ("sessionId", "audioSourceRef")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_session_previews_session_source"`);
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
- Consumes: `buildTimeline`, `parseSamples` (Task 1); `selectAudioSource`, `AudioSourceLevel` (Task 2); `SessionPreview`, `PreviewState`, `isLegalPreviewTransition` (Task 3); `StorageService.presignGet`, `StorageService.getObjectText` (Task 4); `CommandsService.queue`, `CommandType` (existing); `Session`, `Track`, `Manifest` (existing).
- Produces:
  - `PreviewService.status(sessionId: string): Promise<PreviewStatus>`
  - `PreviewService.timeline(sessionId: string, bucketCount: number): Promise<Timeline>`
  - `PreviewService.requestRender(sessionId: string, audioSourceRef?: string): Promise<PreviewStatus>`
  - `PreviewService.mediaUrl(sessionId: string, audioSourceRef?: string): Promise<string>`
  - `interface PreviewStatus { sessionId: string; state: PreviewState; audioSources: AudioSourceView[]; sourcePath: 'local' | 'storage' | null; failureReason: string | null; durationMs: number | null; keysAndClicks: 'not-captured' }`

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

  it('does not re-render a ready proxy', async () => {
    const { service, previews, commands } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Ready, audioSourceRef: 'usb2' });
    await service.requestRender('s1', 'usb2');
    expect(commands.queue).not.toHaveBeenCalled();
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
- `requestRender` throws `BadRequestException` unless `session.state === SessionState.Stored`, and returns early without queueing when a `ready` row already exists for that audio source.
- `requestRender` resolves the agent id from the manifest's `agent_id`, and passes `{ prefix, audioSourceRef, previewId }` as the command payload.
- `mediaUrl` throws `NotFoundException` when no `ready` row exists — it must never silently regenerate a proxy.
- Register `PreviewModule` in `src/app.module.ts`, importing `TypeOrmModule.forFeature([Session, Manifest, SessionPreview])`, `StorageModule`, `SessionsModule`, `AuthModule`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/preview/preview.service.spec.ts`
Expected: PASS, 6 tests

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
- Produces: routes `GET /api/sessions/:id/preview`, `POST /api/sessions/:id/preview`, `GET /api/sessions/:id/preview/media`, `GET /api/sessions/:id/timeline`.

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
    const methods = ['status', 'requestRender', 'media', 'timeline'] as const;
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
    const service = { mediaUrl: jest.fn().mockResolvedValue('https://signed') };
    const controller = new PreviewController(service as never);
    const res = { redirect: jest.fn() };
    await controller.media('s1', undefined, res as never);
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://signed');
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

  @Post(':id/preview')
  requestRender(@Param('id', ParseUUIDPipe) id: string, @Query('audio') audio?: string) {
    return this.preview.requestRender(id, audio);
  }

  /**
   * Redirects rather than streaming: the API must not become the data path
   * for video, and a redirect lets the browser's Range requests reach MinIO
   * directly, which is what makes seeking work.
   */
  @Get(':id/preview/media')
  async media(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('audio') audio: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.preview.mediaUrl(id, audio));
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
Expected: PASS, 2 tests

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
  - `interface RenderInput { videoSegments: string[]; audioSegments: string[]; outPath: string }`
  - `function buildProxyArgs(input: RenderInput): string[]`
  - `function buildVolumedetectArgs(concatListPath: string): string[]`
  - `function buildConcatList(paths: string[]): string`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/preview/render.spec.ts
import { buildConcatList, buildProxyArgs, buildVolumedetectArgs } from './render';

describe('buildProxyArgs', () => {
  const args = buildProxyArgs({ videoSegments: ['/v.txt'], audioSegments: ['/a.txt'], outPath: '/out.mp4' });

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

  it('carries exactly one audio stream, because a browser plays only the first', () => {
    expect(args.filter((a) => a === '-c:a')).toHaveLength(1);
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
 * Builds the ffmpeg invocations for a preview proxy.
 *
 * Rendering runs here rather than in the API because the API pod has 500m of
 * CPU, no /dev/dri and no ffmpeg binary: software-only rendering there measured
 * ~98-123 minutes for a four-hour session while also serving the console. This
 * host has the GPU, 24 cores and the files.
 *
 * Argument construction is separated from execution so the flags that matter --
 * faststart above all -- are testable without spawning ffmpeg.
 */

export interface RenderInput {
  /** Path to an ffmpeg concat list file for the screen segments. */
  videoSegments: string[];
  /** Path to an ffmpeg concat list file for the chosen audio source. */
  audioSegments: string[];
  outPath: string;
}

export const VAAPI_DEVICE = '/dev/dri/renderD128';

export function buildConcatList(paths: string[]): string {
  return paths.map((path) => `file '${path}'\n`).join('');
}

export function buildProxyArgs(input: RenderInput): string[] {
  return [
    '-y', '-loglevel', 'error',
    '-vaapi_device', VAAPI_DEVICE,
    '-f', 'concat', '-safe', '0', '-i', input.videoSegments[0],
    '-f', 'concat', '-safe', '0', '-i', input.audioSegments[0],
    '-vf', 'scale=960:540,format=nv12,hwupload',
    '-c:v', 'h264_vaapi', '-qp', '32', '-r', '10',
    // One audio stream: a browser plays only the first track in <video> and
    // exposes no switcher, so extra streams would be unreachable weight.
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-shortest',
    // The whole point: moov at the front, so the browser can seek without
    // downloading the file.
    '-movflags', '+faststart',
    input.outPath,
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
Expected: PASS, 6 tests

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
- Consumes: `buildProxyArgs`, `buildConcatList`, `buildVolumedetectArgs` (Task 7).
- Produces: `AgentDeps.capture.renderPreview(sessionId: string, prefix: string, audioSourceRef?: string): Promise<{ objectKey: string; bytes: number; durationMs: number; sourcePath: 'local' | 'storage' }>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to agent/src/agent.spec.ts
describe('render-preview', () => {
  const command = {
    command_id: 'c1',
    type: 'render-preview' as const,
    session_id: 's1',
    payload: { prefix: 'sessions/2026/09/07/s1', audioSourceRef: 'usb2' },
  };

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

  it('renders and reports which source path it read from', async () => {
    const deps = makeDeps({ isRunning: () => false });
    deps.capture.renderPreview.mockResolvedValue({
      objectKey: 'sessions/2026/09/07/s1/preview/proxy-usb2.mp4',
      bytes: 1290771,
      durationMs: 87898,
      sourcePath: 'local',
    });
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 20 });

    await agent.handle(command);

    expect(deps.api.post).toHaveBeenCalledWith(
      '/api/sessions/s1/preview-complete',
      expect.objectContaining({ state: 'ready', source_path: 'local' }),
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
   * Renders a preview proxy.
   *
   * Never runs while capture is live. A recording cannot be repeated and a
   * render always can, so on contention the render defers -- and the API is
   * told, so the operator sees "waiting for the recording to finish" instead
   * of a request that vanished.
   *
   * Strictly read-only on session media: it writes one new object and has no
   * delete path anywhere.
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
        command.payload.audioSourceRef as string | undefined,
      );
      await this.reportPreview(command.session_id, {
        state: 'ready',
        object_key: result.objectKey,
        bytes: result.bytes,
        duration_ms: result.durationMs,
        source_path: result.sourcePath,
      });
    } catch (error) {
      // Inert failure: nothing was modified, so a retry is always safe.
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

In `agent/src/main.ts`, implement `capture.renderPreview` to: locate segments locally under `config.recordingDir/<sessionId>` and **fall back to downloading from MinIO** when absent (reporting `sourcePath` accordingly); run `buildVolumedetectArgs` per audio source to measure levels; pick the source (or honour `audioSourceRef`); run `buildProxyArgs`; upload the result to `<prefix>/preview/proxy-<sourceRef>.mp4` via the existing `Uploader`; return the object key, size, duration and source path.

**The fallback exists because local files may be gone by the time someone looks at a session**, for reasons preview does not control and does not participate in. Without it, preview would fail exactly on older sessions — the case where "what is in this?" is hardest to answer from memory.

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
- Consumes: `SessionPreview`, `PreviewState`, `isLegalPreviewTransition` (Task 3).
- Produces: `PreviewService.completeRender(sessionId: string, dto: PreviewCompleteDto): Promise<void>`; route `POST /api/sessions/:id/preview-complete` carrying `@AgentRoute()` + `AgentRoleGuard`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/preview/preview.service.spec.ts
describe('PreviewService.completeRender', () => {
  it('marks a rendered proxy ready and records which path it came from', async () => {
    const { service, previews } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Rendering, audioSourceRef: 'usb2' });
    await service.completeRender('s1', {
      agent_id: 'a1', state: 'ready', object_key: 'k', bytes: 1290771,
      duration_ms: 87898, source_path: 'local',
    } as never);
    expect(previews.save).toHaveBeenCalledWith(
      expect.objectContaining({ state: PreviewState.Ready, sourcePath: 'local' }),
    );
  });

  it('records a failure reason instead of leaving the row rendering forever', async () => {
    const { service, previews } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Rendering, audioSourceRef: 'usb2' });
    await service.completeRender('s1', {
      agent_id: 'a1', state: 'failed', reason: 'render_failed', detail: 'ffmpeg died',
    } as never);
    expect(previews.save).toHaveBeenCalledWith(
      expect.objectContaining({ state: PreviewState.Failed, failureReason: expect.stringContaining('ffmpeg died') }),
    );
  });

  it('keeps a deferred render pending so the operator can retry after recording', async () => {
    const { service, previews } = makeService();
    previews.findOne.mockResolvedValue({ state: PreviewState.Rendering, audioSourceRef: 'usb2' });
    await service.completeRender('s1', {
      agent_id: 'a1', state: 'deferred', reason: 'capture_running',
    } as never);
    expect(previews.save).toHaveBeenCalledWith(
      expect.objectContaining({ state: PreviewState.Pending }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/preview/preview.service.spec.ts`
Expected: FAIL — `service.completeRender is not a function`

- [ ] **Step 3: Implement the DTO, the service method and the route**

The DTO validates `agent_id` (UUID), `state` (`IsIn(['ready','failed','deferred'])`), and optional `object_key`, `bytes`, `duration_ms`, `source_path`, `reason`, `detail`.

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
- Consumes: `GET/POST /api/sessions/:id/preview`, `GET /api/sessions/:id/preview/media`, `GET /api/sessions/:id/timeline` (Tasks 5, 6).
- Produces: `openPreview(sessionId)` in `app.js`, reachable from a sessions-list row.

- [ ] **Step 1: Add the markup**

Add to `public/index.html` a `<section id="screen-preview" hidden>` containing: a `<video id="preview-video" controls preload="metadata">`, a `<div id="preview-render-note">`, a `<div id="preview-sources">`, a `<canvas id="preview-timeline">`, a `<div id="preview-legend">`, and a `<p id="preview-activity-note">`.

Note: the `<video>` must **not** carry a `crossorigin` attribute — adding one would require bucket CORS that is deliberately not configured.

- [ ] **Step 2: Implement the preview screen in `app.js`**

Requirements:
- `openPreview(sessionId)` fetches status and timeline in parallel; the **timeline renders immediately without waiting for the proxy**, because it comes from a text file that needs no rendering. Making the operator wait ~7 minutes to see which windows they were in would be an artificial delay.
- If the status is not `ready`, POST to request a render and poll status, showing the path-specific wait: `'Rendering from local files — about 7 minutes'` for `local`, `'Fetching 1.6 GB from storage, then rendering — about 20 minutes'` for `storage`. A silent thirty-times-longer render reads as a hang.
- If the status is `deferred`/`pending` with `capture_running`, show `'Waiting for the current recording to finish.'`
- The sources panel lists every audio source with its measured level, marks the selected one with its reason verbatim from the API, and labels a silent source as `'digital silence — this device was probably not the active input'`. It must **not** imply a silent track is defective; add the note that all offered sources were reported available by the agent, which is correct behaviour.
- Clicking a non-selected source POSTs a render for it and polls; the first proxy is kept.
- The timeline canvas draws two lanes: window focus (top-8 colours plus one neutral "other") and mouse movement density. Clicking anywhere seeks `preview-video` to that offset.
- `preview-activity-note` reads exactly: `'Keystroke and click density not captured — see the tracker defect in TASKS.md.'` Draw **no** keys/clicks lane, no zero bar, no flat line.
- Add a "Preview" control to each `stored` row in `loadSessions()`.

- [ ] **Step 3: Verify by hand against the deployed service**

Open `https://screencast.alfares.cz/console`, preview session `d5b209c3-d822-4d22-840b-b05f9b1384b5`, and confirm: the timeline appears before the video is ready; the focus lane shows the six real windows; the sources panel shows two sources at -91.0 dB labelled as digital silence and one at -20.3 dB peak marked selected; the video plays with audio; seeking to a late offset works; and no keys/clicks lane is drawn.

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

Fetch a presigned URL from `GET /api/sessions/:id/preview/media`, then confirm the object answers `Accept-Ranges: bytes` and returns `206 Partial Content` for `Range: bytes=0-102399`. Confirm the `<video>` element plays and seeks in a real browser.

**If bucket CORS configuration turns out to be genuinely required, STOP and raise it. Do not configure the bucket.**

- [ ] **Step 3: Record a fresh session and preview it end to end**

Record a short session through the console, save it, then preview it. Confirm the proxy renders, the timeline matches what was actually done, and the window titles are the real ones.

- [ ] **Step 4: Verify the contention rule live**

Start a recording, request a preview render of an *older* stored session while it runs, and confirm the render defers rather than competing with capture, and that the console says so.

- [ ] **Step 5: Confirm nothing was deleted**

Verify local session directories and all MinIO objects are intact, and that the only new object is `preview/proxy-<source>.mp4`.

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

**Spec coverage.** Agent-side rendering with the three containments → Tasks 7, 8. Local-then-MinIO fallback with its reasoning → Task 8. Audio selection with override and the sources panel → Tasks 2, 5, 10. Three-lane timeline with keys/clicks omitted → Tasks 1, 5, 10. Top-8 title palette → Tasks 1, 10. Server-side bucketing → Tasks 1, 5. Sanitiser boundary test → Task 5. Render lifecycle and two distinguishable waits → Tasks 3, 8, 9, 10. New screen with stable URL and operator-lane routes → Tasks 6, 10. Presigning without new permissions, CORS verified not assumed → Tasks 4, 11. Corrected figures → carried in Task 8's comment and the spec. No deletion anywhere.

**Type consistency.** `PreviewState` and `isLegalPreviewTransition` (Task 3) are used identically in Tasks 5 and 9. `AudioSourceView`/`AudioSourceLevel` (Task 2) flow into `PreviewStatus` (Task 5) and the panel (Task 10). `Timeline`/`TimelineBucket`/`FocusInterval` (Task 1) are consumed unchanged by Tasks 5 and 10. `renderPreview`'s return shape (Task 8) matches the `preview-complete` DTO fields (Task 9) and the entity columns (Task 3): `objectKey`/`object_key`, `bytes`, `durationMs`/`duration_ms`, `sourcePath`/`source_path`.

**Placeholder scan.** No TBDs. Task 5's and Task 10's implementation steps state requirements rather than full listings — deliberate, because the service wiring and the canvas drawing are long and mechanical, and every type, route, literal string and behavioural rule they must satisfy is given exactly. The tests that gate them are written out in full.

**Verified rather than assumed.** Task 6's metadata key names were confirmed against the source: `AGENT_ROUTE` and `PUBLIC_ROUTE`.
