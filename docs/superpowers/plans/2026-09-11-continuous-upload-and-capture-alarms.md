# Continuous Upload and Capture Alarms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload each 60-second segment to MinIO as soon as it is closed, so a crash loses seconds rather than hours, and alarm loudly in the console when capture or upload stops working.

**Architecture:** The agent gains an upload queue drained from its existing 5-second tick loop: on each tick it lists every live track directory, treats every segment but the highest-numbered one as closed and eligible, and uploads with bounded concurrency. Session state is untouched — continuous upload is tracked per track through the `tracks.upload_state` column that already exists. Health fields ride the existing progress report; the console renders them as a red banner it cannot show reassuring copy beside.

**Tech Stack:** Node 24 + TypeScript on the agent (systemd user unit), NestJS 10 + TypeORM 0.3 + Postgres in the API pod, `@aws-sdk/client-s3` against MinIO, framework-free vanilla JS console, Jest + ts-jest.

**Spec:** [`docs/superpowers/specs/2026-09-11-continuous-upload-and-capture-alarms-design.md`](../specs/2026-09-11-continuous-upload-and-capture-alarms-design.md)

## Global Constraints

- **Upload failure never stops, pauses or degrades capture.** Local media is authoritative (`AGENTS.md` rule 8). Every upload path catches its own errors and returns; nothing in this plan may throw into `tick()` or into ffmpeg's lifetime. This was an explicit owner decision after considering and rejecting the opposite.
- **The file currently being written is never read.** Only segments with a higher-numbered sibling are eligible. Uploading an open segment ships a truncated object.
- **Deletion happens on exactly one new path: Discard.** Scoped to `<prefix>/` for one session id, refused unless the session state is `discarded`, and it never touches local files. No other code in this plan may delete anything, anywhere.
- **The API stays read-only on storage.** `StorageService` gains no delete, no put. The agent already holds `s3:DeleteObject` from the provisioned `screencast-rw` policy; no credential widens.
- **The session state machine does not change.** `preparing → recording → stopping → review → uploading → stored` keeps its exact current meanings. Per-track progress lives in `tracks.upload_state`.
- **`stalled` is blocking-grade, `quiet` is advisory.** `stalled` means zero new bytes across 3 consecutive ticks while another track advances. The `quiet` byte-rate floor is deliberately unfixed — ship it as a soft warning and tune against a real recording before giving it more weight.
- **The console shows no reassuring language while any alarm is active.**
- **`bytes` is a bigint typed as `string`** on the `Track` entity. A four-hour 4K session exceeds 2^53. Never parse it into a plain number for storage; `Number()` at render time only.
- **The activity stream carries no keystroke content and must never start to.** `active_window` stays display-only, never persisted, never logged.
- Tests run with `npx jest` from the repo root and cover both `src/` and `agent/`. **Baseline is 440 tests across 41 suites.**
- Commit to `main` auto-deploys the API; the agent is a systemd user unit installed separately by `scripts/install-agent.sh`. Verify a deploy by pod image and age, not by the deploy banner.

---

### Task 1: Segment eligibility (pure module)

Which files in a track directory are closed and safe to upload. Pure — no I/O beyond a directory listing passed in — so it is the cheapest place to pin the rule that protects against shipping a half-written segment.

**Files:**
- Create: `agent/src/upload/eligibility.ts`
- Test: `agent/src/upload/eligibility.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function closedSegments(names: string[]): string[]`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/upload/eligibility.spec.ts
import { closedSegments } from './eligibility';

describe('closedSegments', () => {
  it('holds back the highest-numbered segment, which ffmpeg is still writing', () => {
    // Uploading the open segment ships a truncated object that HEAD reports at
    // the wrong size for ever after.
    expect(closedSegments(['seg-00000.mp4', 'seg-00001.mp4', 'seg-00002.mp4'])).toEqual([
      'seg-00000.mp4',
      'seg-00001.mp4',
    ]);
  });

  it('returns nothing for a single segment, because it is still open', () => {
    expect(closedSegments(['seg-00000.mp4'])).toEqual([]);
  });

  it('returns nothing for an empty directory', () => {
    expect(closedSegments([])).toEqual([]);
  });

  it('ignores files that are not segments', () => {
    // events.jsonl and manifest.json travel at Save, not here.
    expect(closedSegments(['events.jsonl', 'seg-00000.m4a', 'seg-00001.m4a'])).toEqual([
      'seg-00000.m4a',
    ]);
  });

  it('orders by segment number, not by string sort of mixed widths', () => {
    // Zero-padding makes lexical order chronological today, but a rollover past
    // 99999 would break that silently.
    expect(closedSegments(['seg-00010.mp4', 'seg-00002.mp4', 'seg-00001.mp4'])).toEqual([
      'seg-00001.mp4',
      'seg-00002.mp4',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest agent/src/upload/eligibility.spec.ts`
Expected: FAIL — `Cannot find module './eligibility'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// agent/src/upload/eligibility.ts

/**
 * The segments in a track directory that are finished and safe to upload.
 *
 * ffmpeg is always writing the highest-numbered segment, so it is excluded: an
 * object PUT from a file still being appended to lands short, and the size
 * check that makes a resumed upload cheap would then skip it for ever as
 * "already present".
 */
export function closedSegments(names: string[]): string[] {
  const segments = names
    .filter((name) => /^seg-\d+\./.test(name))
    .map((name) => ({ name, index: Number(name.slice(4, name.indexOf('.'))) }))
    .sort((a, b) => a.index - b.index);

  return segments.slice(0, -1).map((s) => s.name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest agent/src/upload/eligibility.spec.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add agent/src/upload/eligibility.ts agent/src/upload/eligibility.spec.ts
git commit -m "feat(agent): decide which segments are closed and safe to upload"
```

---

### Task 2: Concurrent upload in `Uploader.uploadAll`

`uploadAll` uploads serially and then verifies serially — 180 sequential round trips to an external HTTPS endpoint, measured at ~850 KB/s for 162 MB. Make both passes concurrent. This is self-contained and benefits Save immediately, before any continuous-upload wiring exists.

**Files:**
- Modify: `agent/src/upload/uploader.ts:107-121` (`uploadAll`), `agent/src/upload/uploader.ts:96-105` (`verify`)
- Test: `agent/src/upload/uploader.spec.ts` (append; existing describes are `Uploader.uploadFile`, `Uploader.verify`, `what the uploader must never do`)

**Interfaces:**
- Consumes: `S3Like`, `ExpectedObject`, `UploadResult` from Task 0 state of `uploader.ts` (already exist).
- Produces:
  - `Uploader` constructor options gain `concurrency`: `{ retries: number; backoffMs: number; concurrency: number }`, default `{ retries: 5, backoffMs: 500, concurrency: 3 }`
  - `uploadAll` and `verify` keep their exact current signatures and return types.

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/upload/uploader.spec.ts — append at end of file
describe('Uploader.uploadAll concurrency', () => {
  it('uploads more than one object at a time', async () => {
    // Serial upload of a 162 MB session took 3m12s against the external MinIO
    // endpoint, almost all of it round-trip latency rather than bandwidth.
    let inFlight = 0;
    let peak = 0;
    const s3 = fakeS3({
      head: jest.fn(async () => null),
      put: jest.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      }),
    });
    const uploader = new Uploader(s3, 'bucket', { retries: 1, backoffMs: 1, concurrency: 3 });

    const files = Array.from({ length: 9 }, (_, i) => ({
      path: `/local/seg-${i}`,
      key: `p/seg-${i}`,
      bytes: 10,
    }));
    await uploader.uploadAll(files);

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('uploads every file exactly once', async () => {
    const s3 = fakeS3({ head: jest.fn(async () => null) });
    const uploader = new Uploader(s3, 'bucket', { retries: 1, backoffMs: 1, concurrency: 3 });

    const files = Array.from({ length: 7 }, (_, i) => ({
      path: `/local/seg-${i}`,
      key: `p/seg-${i}`,
      bytes: 10,
    }));
    const result = await uploader.uploadAll(files);

    expect(result.objects).toBe(7);
    expect([...s3.puts].sort()).toEqual(files.map((f) => f.key).sort());
  });

  it('still reports a missing object after a concurrent run', async () => {
    // Concurrency must not turn a failed verify into a pass.
    const s3 = fakeS3({
      head: jest.fn(async (key: string) => (key === 'p/seg-1' ? null : { contentLength: 10 })),
    });
    const uploader = new Uploader(s3, 'bucket', { retries: 1, backoffMs: 1, concurrency: 3 });

    const result = await uploader.uploadAll([
      { path: '/local/seg-0', key: 'p/seg-0', bytes: 10 },
      { path: '/local/seg-1', key: 'p/seg-1', bytes: 10 },
    ]);

    expect(result.verified).toBe(false);
    expect(result.missing).toEqual(['p/seg-1']);
  });

  it('propagates a failure that exhausts its retries', async () => {
    const s3 = fakeS3({
      head: jest.fn(async () => null),
      put: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    });
    const uploader = new Uploader(s3, 'bucket', { retries: 2, backoffMs: 1, concurrency: 3 });

    await expect(
      uploader.uploadAll([{ path: '/local/a', key: 'p/a', bytes: 10 }]),
    ).rejects.toThrow(/upload failed after 2 attempts/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest agent/src/upload/uploader.spec.ts -t concurrency`
Expected: FAIL — `peak` is 1, because `uploadAll` awaits each file in turn.

- [ ] **Step 3: Write minimal implementation**

Replace the constructor options and both passes in `agent/src/upload/uploader.ts`:

```typescript
  constructor(
    private readonly s3: S3Like,
    private readonly bucket: string,
    private readonly options: { retries: number; backoffMs: number; concurrency: number } = {
      retries: 5,
      backoffMs: 500,
      concurrency: 3,
    },
  ) {}
```

```typescript
  /**
   * Runs `worker` over `items` with at most `concurrency` in flight.
   *
   * Bounded rather than unbounded: a four-hour session is thousands of
   * segments, and `Promise.all` over all of them would open thousands of
   * sockets against MinIO at once.
   */
  private async pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const runners = Array.from({ length: Math.min(this.options.concurrency, queue.length) }, () =>
      (async () => {
        for (;;) {
          const item = queue.shift();
          if (item === undefined) return;
          await worker(item);
        }
      })(),
    );
    await Promise.all(runners);
  }

  /**
   * Independent readback of every object.
   *
   * Run after all uploads, as a separate pass: a PUT that returned success can
   * still have landed short, and the uploading process is the last thing that
   * should be trusted to audit itself.
   */
  async verify(expected: ExpectedObject[]): Promise<VerifyResult> {
    const missing: string[] = [];

    await this.pool(expected, async (object) => {
      const head = await this.s3.head(object.key).catch(() => null);
      if (!head || head.contentLength !== object.bytes) missing.push(object.key);
    });

    // Sorted so a missing-object report is stable regardless of which worker
    // happened to finish first.
    missing.sort();
    return { verified: missing.length === 0, missing };
  }

  /** Uploads every file, then verifies the whole set. */
  async uploadAll(files: { path: string; key: string; bytes: number }[]): Promise<UploadResult> {
    await this.pool(files, async (file) => {
      await this.uploadFile(file.path, file.key, file.bytes);
    });

    const result = await this.verify(files.map((f) => ({ key: f.key, bytes: f.bytes })));

    return {
      objects: files.length,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      verified: result.verified,
      missing: result.missing,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest agent/src/upload/uploader.spec.ts`
Expected: PASS — the four new tests plus every pre-existing one in the file.

- [ ] **Step 5: Commit**

```bash
git add agent/src/upload/uploader.ts agent/src/upload/uploader.spec.ts
git commit -m "perf(agent): upload and verify with bounded concurrency"
```

---

### Task 3: Expose live track directories on `CaptureSession`

The upload queue must enumerate track directories while recording. `CaptureSession.tracks` is private (`agent/src/capture/session.ts:61`) and `states()` returns no path. Add a narrow accessor rather than widening `tracks`.

**Files:**
- Modify: `agent/src/capture/session.ts` (add `trackDirs()` beside `states()`, around line 230)
- Test: `agent/src/capture/session.spec.ts` (append)

**Interfaces:**
- Consumes: `CaptureSession.trackDir(track)` (already public), `this.tracks` (private field set by `start()`).
- Produces:
  - `interface LiveTrackDir { trackId: string; kind: string; dir: string }`
  - `CaptureSession.trackDirs(): LiveTrackDir[]`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/capture/session.spec.ts — append at end of file
describe('CaptureSession.trackDirs', () => {
  it('is empty before start, because no tracks are known yet', () => {
    const session = new CaptureSession({
      sessionId: 'sess-2',
      hostname: 'alfares',
      display: ':0.0',
      rootDir: '/home/ssf/recordings',
      displays: [{ id: 'HDMI-A-0', width: 3840, height: 2160, x: 0, y: 0 }],
    });

    expect(session.trackDirs()).toEqual([]);
  });

  it('reports each started track with the directory its segments land in', async () => {
    // The upload queue enumerates these while recording. If a directory here
    // disagreed with trackDir(), uploaded keys would not match the layout the
    // API verifies against.
    //
    // Metadata-only, and `spawnInput` stubbed: `StartOptions` is
    // `{ spawnInput?: SpawnFn }` and overrides ONLY the activity listener. A
    // screen or audio track here would spawn a real ffmpeg from the
    // supervisor's own default spawn, which no option in this signature
    // replaces. Follow the existing tests at the top of this file.
    const session = new CaptureSession({
      sessionId: 'sess-2',
      hostname: 'alfares',
      display: ':0.0',
      rootDir: '/home/ssf/recordings',
      displays: [{ id: 'HDMI-A-0', width: 3840, height: 2160, x: 0, y: 0 }],
    });

    await session.start(
      [{ track_id: 'meta', kind: 'metadata', source_ref: 'activity', sample_hz: 5 }],
      0,
      {
        spawnInput: () =>
          ({ on: () => undefined, stdout: null, stderr: null, kill: () => true }) as never,
      },
    );

    expect(session.trackDirs()).toEqual([
      { trackId: 'meta', kind: 'metadata', dir: '/home/ssf/recordings/sess-2/alfares/metadata' },
    ]);

    await session.stop('agent-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest agent/src/capture/session.spec.ts -t trackDirs`
Expected: FAIL — `session.trackDirs is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `agent/src/capture/session.ts`, immediately after `states()`:

```typescript
/** One live track and the directory its segments are being written into. */
export interface LiveTrackDir {
  trackId: string;
  kind: string;
  dir: string;
}
```

```typescript
  /**
   * Every started track with its output directory.
   *
   * The continuous uploader needs paths while capture is live; `states()`
   * deliberately carries only counters. Exposed as this narrow view rather
   * than by widening `tracks`, which is the session's own bookkeeping.
   */
  trackDirs(): LiveTrackDir[] {
    return this.tracks.map((track) => ({
      trackId: track.track_id,
      kind: track.kind,
      dir: this.trackDir(track),
    }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest agent/src/capture/session.spec.ts`
Expected: PASS, including every pre-existing layout test in the file.

- [ ] **Step 5: Commit**

```bash
git add agent/src/capture/session.ts agent/src/capture/session.spec.ts
git commit -m "feat(agent): expose live track directories for continuous upload"
```

---

### Task 4: Fix the session prefix at recording start

`s3Prefix` is set at Save (`src/sessions/sessions.service.ts:195-207`). Continuous upload needs it at `start`, and deriving it from `startedAt` at that moment is strictly safer than deriving it later — that is exactly what the existing comment wants to protect.

**Files:**
- Modify: `src/sessions/sessions.service.ts` — `start` (find the method that transitions to `SessionState.Recording` and queues `CommandType.Start`), and `save` at lines 195-207
- Test: `src/sessions/sessions.service.spec.ts` (append)

**Interfaces:**
- Consumes: `SessionsService.prefixFor(session)` (already exists, `sessions.service.ts:253`).
- Produces: the `start` command payload gains `prefix: string` alongside its existing `t0`. `save` reuses `session.s3Prefix` when already set.

- [ ] **Step 1: Write the failing test**

```typescript
// src/sessions/sessions.service.spec.ts — append at end of file
describe('the S3 prefix is fixed when recording starts', () => {
  it('persists the prefix at start, not at save', async () => {
    // A session that starts before midnight and saves after it would otherwise
    // be verified against a prefix nothing was ever written to.
    const { service, session } = makeService({ agents: ['a1'], state: SessionState.Preparing });
    (session as Record<string, unknown>).startedAt = new Date('2026-09-10T22:30:00Z');

    await service.reportStatus('s1', {
      agent_id: 'a1',
      state: 'ready',
      clock: { synchronised: true, offset_ms: 0 },
    } as never);

    expect(session.s3Prefix).toBe('sessions/2026/09/10/s1');
  });

  it('carries the prefix in the start command, so the agent uploads to it', async () => {
    const { service, session, commands } = makeService({
      agents: ['a1'],
      state: SessionState.Preparing,
    });
    (session as Record<string, unknown>).startedAt = new Date('2026-09-10T22:30:00Z');

    await service.reportStatus('s1', {
      agent_id: 'a1',
      state: 'ready',
      clock: { synchronised: true, offset_ms: 0 },
    } as never);

    const start = commands.find((c) => c.type === 'start');
    expect((start?.payload as Record<string, unknown>)?.prefix).toBe('sessions/2026/09/10/s1');
  });

  it('save reuses the prefix rather than recomputing it', async () => {
    // Recomputing at save is the midnight bug. Reuse is what makes the bytes
    // already uploaded during recording verifiable.
    const { service, session } = makeService({ agents: ['a1'], state: SessionState.Review });
    session.s3Prefix = 'sessions/2026/09/10/s1';
    (session as Record<string, unknown>).startedAt = new Date('2026-09-11T00:30:00Z');

    await service.save('s1');

    expect(session.s3Prefix).toBe('sessions/2026/09/10/s1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/sessions/sessions.service.spec.ts -t "S3 prefix"`
Expected: FAIL — `session.s3Prefix` is `undefined` after the readiness barrier releases, and the `start` payload has no `prefix`.

Note: read the existing `reportStatus` readiness-barrier tests in this file first. The barrier releases `start` only once every participating agent reports `ready`; match how those tests drive it rather than inventing a new path.

- [ ] **Step 3: Write minimal implementation**

In `src/sessions/sessions.service.ts`, where the readiness barrier transitions to `Recording` and queues `CommandType.Start`, set the prefix before queueing:

```typescript
    // Fixed here rather than at Save. The prefix derives from startedAt, and a
    // session that starts before midnight and saves after it would otherwise be
    // verified against a prefix nothing was uploaded to. Continuous upload also
    // needs it now: the agent starts writing objects during recording.
    session.s3Prefix = this.prefixFor(session);
    await this.sessions.save(session);
```

and include it in the queued payload:

```typescript
      await this.commands.queue(agentId, CommandType.Start, sessionId, { t0, prefix: session.s3Prefix });
```

In `save`, reuse rather than recompute:

```typescript
    // Already fixed at start. Recomputing here is the midnight bug, and would
    // also orphan every object uploaded during recording.
    const prefix = session.s3Prefix ?? this.prefixFor(session);
    session.s3Prefix = prefix;
    await this.sessions.save(session);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/sessions/sessions.service.spec.ts`
Expected: PASS, including every pre-existing barrier and transition test.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/sessions.service.ts src/sessions/sessions.service.spec.ts
git commit -m "feat(api): fix the S3 prefix when recording starts"
```

---

### Task 5: The continuous upload queue

The agent's upload queue: scan live track directories each tick, upload closed segments that have not been uploaded, never block capture.

**Files:**
- Create: `agent/src/upload/continuous.ts`
- Test: `agent/src/upload/continuous.spec.ts`

**Interfaces:**
- Consumes: `closedSegments` (Task 1), `Uploader` (Task 2), `LiveTrackDir` (Task 3).
- Produces:
  - `interface ContinuousDeps { listDir(dir: string): Promise<string[]>; sizeOf(path: string): Promise<number>; upload(path: string, key: string, bytes: number): Promise<void> }`
  - `interface UploadHealth { queued: number; failures: number; oldestPendingMs: number | null }`
  - `class ContinuousUploader { constructor(deps: ContinuousDeps, now?: () => number); sweep(tracks: LiveTrackDir[], prefix: string, hostname: string): Promise<void>; health(): UploadHealth }`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/upload/continuous.spec.ts
import { ContinuousUploader, ContinuousDeps } from './continuous';

function makeDeps(overrides: Partial<ContinuousDeps> = {}): ContinuousDeps & { uploaded: string[] } {
  const uploaded: string[] = [];
  return {
    uploaded,
    listDir: jest.fn(async () => ['seg-00000.mp4', 'seg-00001.mp4', 'seg-00002.mp4']),
    sizeOf: jest.fn(async () => 100),
    upload: jest.fn(async (_path: string, key: string) => {
      uploaded.push(key);
    }),
    ...overrides,
  } as ContinuousDeps & { uploaded: string[] };
}

const track = { trackId: 't1', kind: 'screen', dir: '/rec/s1/alfares/screen-HDMI-A-0' };

describe('ContinuousUploader.sweep', () => {
  it('uploads closed segments to the key layout the API verifies', async () => {
    // <prefix>/<hostname>/<kind>-<source_ref>/<file>. The local directory name
    // is already that shape, so the key is the prefix plus the tail.
    const deps = makeDeps();
    const uploader = new ContinuousUploader(deps);

    await uploader.sweep([track], 'sessions/2026/09/11/s1', 'alfares');

    expect(deps.uploaded).toEqual([
      'sessions/2026/09/11/s1/alfares/screen-HDMI-A-0/seg-00000.mp4',
      'sessions/2026/09/11/s1/alfares/screen-HDMI-A-0/seg-00001.mp4',
    ]);
  });

  it('never uploads the segment ffmpeg is still writing', async () => {
    const deps = makeDeps();
    const uploader = new ContinuousUploader(deps);

    await uploader.sweep([track], 'p', 'alfares');

    expect(deps.uploaded.some((key) => key.endsWith('seg-00002.mp4'))).toBe(false);
  });

  it('does not re-upload a segment it already sent', async () => {
    // Every tick re-lists the directory. Without this the same segment is sent
    // every five seconds for the rest of the session.
    const deps = makeDeps();
    const uploader = new ContinuousUploader(deps);

    await uploader.sweep([track], 'p', 'alfares');
    await uploader.sweep([track], 'p', 'alfares');

    expect(deps.uploaded).toHaveLength(2);
  });

  it('keeps capture alive when an upload throws', async () => {
    // The controlling rule: an S3 problem must never reach ffmpeg.
    const deps = makeDeps({
      upload: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    });
    const uploader = new ContinuousUploader(deps);

    await expect(uploader.sweep([track], 'p', 'alfares')).resolves.toBeUndefined();
  });

  it('retries a failed segment on the next sweep', async () => {
    let fail = true;
    const uploaded: string[] = [];
    const deps = makeDeps({
      upload: jest.fn(async (_path: string, key: string) => {
        if (fail) throw new Error('connection reset');
        uploaded.push(key);
      }),
    });
    const uploader = new ContinuousUploader(deps);

    await uploader.sweep([track], 'p', 'alfares');
    fail = false;
    await uploader.sweep([track], 'p', 'alfares');

    expect(uploaded).toHaveLength(2);
  });

  it('reports health so the console can alarm on a failing upload', async () => {
    const deps = makeDeps({
      upload: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    });
    let clock = 1000;
    const uploader = new ContinuousUploader(deps, () => clock);

    await uploader.sweep([track], 'p', 'alfares');
    clock = 61000;

    const health = uploader.health();
    expect(health.failures).toBeGreaterThan(0);
    expect(health.queued).toBe(2);
    expect(health.oldestPendingMs).toBe(60000);
  });

  it('is clean when everything has been uploaded', async () => {
    const deps = makeDeps();
    const uploader = new ContinuousUploader(deps);

    await uploader.sweep([track], 'p', 'alfares');

    expect(uploader.health()).toEqual({ queued: 0, failures: 0, oldestPendingMs: null });
  });

  it('skips a directory that does not exist yet', async () => {
    // A track whose first segment has not closed has no directory listing.
    const deps = makeDeps({
      listDir: jest.fn(async () => {
        throw new Error('ENOENT');
      }),
    });
    const uploader = new ContinuousUploader(deps);

    await expect(uploader.sweep([track], 'p', 'alfares')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest agent/src/upload/continuous.spec.ts`
Expected: FAIL — `Cannot find module './continuous'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// agent/src/upload/continuous.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest agent/src/upload/continuous.spec.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add agent/src/upload/continuous.ts agent/src/upload/continuous.spec.ts
git commit -m "feat(agent): upload closed segments while recording continues"
```

---

### Task 6: Stall and quiet detection

A track whose ffmpeg is alive but producing nothing reports healthy today: `degraded` flips only in `handleExit` (`agent/src/capture/supervisor.ts:48-65`). That is how a 21-minute session captured 914 KB on one microphone and said nothing.

**Files:**
- Create: `agent/src/capture/health.ts`
- Test: `agent/src/capture/health.spec.ts`

**Interfaces:**
- Consumes: the shape returned by `CaptureSession.states()` — `{ trackId: string; degraded: boolean; segments: number; bytes: number }`.
- Produces:
  - `type TrackHealth = 'ok' | 'stalled' | 'quiet'`
  - `interface HealthSample { trackId: string; kind: string; bytes: number }`
  - `class HealthTracker { constructor(options?: { stallTicks?: number; quietBytesPerTick?: number }); observe(samples: HealthSample[]): Map<string, TrackHealth> }`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/capture/health.spec.ts
import { HealthTracker } from './health';

describe('HealthTracker', () => {
  it('says nothing on the first observation, because there is no delta yet', () => {
    // A session's first tick has no previous sample. Alarming here would fire
    // on every recording at second five.
    const tracker = new HealthTracker();
    const health = tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 0 },
      { trackId: 't2', kind: 'audio', bytes: 0 },
    ]);

    expect(health.get('t1')).toBe('ok');
    expect(health.get('t2')).toBe('ok');
  });

  it('marks a track stalled after three ticks of no new bytes while another advances', () => {
    // The 2026-09-10 case: one microphone produced 914 KB in 21 minutes while
    // its sibling produced 31 MB, and reported healthy throughout.
    const tracker = new HealthTracker({ stallTicks: 3 });
    for (let tick = 1; tick <= 4; tick += 1) {
      var health = tracker.observe([
        { trackId: 't1', kind: 'screen', bytes: tick * 1_000_000 },
        { trackId: 't2', kind: 'audio', bytes: 500 },
      ]);
    }

    expect(health!.get('t1')).toBe('ok');
    expect(health!.get('t2')).toBe('stalled');
  });

  it('does not mark a track stalled while every track is idle', () => {
    // If nothing is advancing, the session is paused or ending -- that is not
    // one track failing, and flagging all of them is noise.
    const tracker = new HealthTracker({ stallTicks: 3 });
    for (let tick = 1; tick <= 5; tick += 1) {
      var health = tracker.observe([
        { trackId: 't1', kind: 'screen', bytes: 1000 },
        { trackId: 't2', kind: 'audio', bytes: 500 },
      ]);
    }

    expect(health!.get('t1')).toBe('ok');
    expect(health!.get('t2')).toBe('ok');
  });

  it('recovers to ok when bytes start flowing again', () => {
    const tracker = new HealthTracker({ stallTicks: 2 });
    tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 1_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 500 },
    ]);
    tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 2_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 500 },
    ]);
    tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 3_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 500 },
    ]);
    const health = tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 4_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 900_000 },
    ]);

    expect(health.get('t2')).toBe('ok');
  });

  it('marks an audio track quiet when its byte rate is under the floor', () => {
    // Advisory only. A silent room produces a legitimately small AAC stream,
    // so this warns and never blocks.
    const tracker = new HealthTracker({ stallTicks: 3, quietBytesPerTick: 10_000 });
    tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 1_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 0 },
    ]);
    const health = tracker.observe([
      { trackId: 't1', kind: 'screen', bytes: 5_000_000 },
      { trackId: 't2', kind: 'audio', bytes: 40 },
    ]);

    expect(health.get('t2')).toBe('quiet');
  });

  it('never calls a screen track quiet, because the floor is an audio rule', () => {
    const tracker = new HealthTracker({ stallTicks: 3, quietBytesPerTick: 10_000 });
    tracker.observe([{ trackId: 't1', kind: 'screen', bytes: 0 }]);
    const health = tracker.observe([{ trackId: 't1', kind: 'screen', bytes: 40 }]);

    expect(health.get('t1')).not.toBe('quiet');
  });

  it('never calls a metadata track stalled, since it writes one growing file', () => {
    // events.jsonl grows in small bursts and has no segments; the stall rule
    // does not describe it.
    const tracker = new HealthTracker({ stallTicks: 2 });
    for (let tick = 1; tick <= 4; tick += 1) {
      var health = tracker.observe([
        { trackId: 't1', kind: 'screen', bytes: tick * 1_000_000 },
        { trackId: 't2', kind: 'metadata', bytes: 100 },
      ]);
    }

    expect(health!.get('t2')).toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest agent/src/capture/health.spec.ts`
Expected: FAIL — `Cannot find module './health'`

- [ ] **Step 3: Write minimal implementation**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest agent/src/capture/health.spec.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add agent/src/capture/health.ts agent/src/capture/health.spec.ts
git commit -m "feat(agent): detect a track that is alive but capturing nothing"
```

---

### Task 7: Durable pending-report queue

The 2026-09-10 incident's lasting harm was a failure report that lived only in `this.pending` (`agent/src/agent.ts:89`) and died with the process. Persist it.

**Files:**
- Create: `agent/src/pending-store.ts`
- Test: `agent/src/pending-store.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PendingReport { path: string; body: unknown }`
  - `interface PendingStoreDeps { read(): Promise<string | null>; write(contents: string): Promise<void> }`
  - `class PendingStore { constructor(deps: PendingStoreDeps); load(): Promise<PendingReport[]>; save(reports: PendingReport[]): Promise<void> }`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/pending-store.spec.ts
import { PendingStore, PendingStoreDeps } from './pending-store';

function makeDeps(initial: string | null = null): PendingStoreDeps & { contents: string | null } {
  const state = { contents: initial };
  return {
    get contents() {
      return state.contents;
    },
    read: jest.fn(async () => state.contents),
    write: jest.fn(async (contents: string) => {
      state.contents = contents;
    }),
  } as PendingStoreDeps & { contents: string | null };
}

describe('PendingStore', () => {
  it('round-trips queued reports across a restart', async () => {
    // A failure report that dies with the process is why a session sat in
    // `uploading` for ever with no reason recorded anywhere.
    const deps = makeDeps();
    const store = new PendingStore(deps);

    await store.save([{ path: '/api/sessions/s1/status', body: { state: 'failed' } }]);
    const loaded = await new PendingStore(deps).load();

    expect(loaded).toEqual([{ path: '/api/sessions/s1/status', body: { state: 'failed' } }]);
  });

  it('returns an empty queue when no file exists yet', async () => {
    const store = new PendingStore(makeDeps(null));
    expect(await store.load()).toEqual([]);
  });

  it('returns an empty queue rather than throwing on a corrupt file', async () => {
    // A crash mid-write leaves a partial line. Losing the queue is bad; failing
    // to start the agent because of it is worse.
    const store = new PendingStore(makeDeps('{not json'));
    expect(await store.load()).toEqual([]);
  });

  it('discards a file whose contents are not an array', async () => {
    const store = new PendingStore(makeDeps('{"path":"/x"}'));
    expect(await store.load()).toEqual([]);
  });

  it('never throws when the write fails, because capture must continue', async () => {
    const deps = makeDeps();
    deps.write = jest.fn(async () => {
      throw new Error('EACCES');
    });
    const store = new PendingStore(deps);

    await expect(store.save([{ path: '/x', body: {} }])).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest agent/src/pending-store.spec.ts`
Expected: FAIL — `Cannot find module './pending-store'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// agent/src/pending-store.ts

/** A queued report that could not be delivered while the API was unreachable. */
export interface PendingReport {
  path: string;
  body: unknown;
}

export interface PendingStoreDeps {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
}

/**
 * Persists undelivered reports so they survive the agent process.
 *
 * On 2026-09-10 an upload finished, its `upload-complete` call failed, and the
 * failure report that would have explained it was pushed onto an in-memory
 * array and lost with the process. The session sat in `uploading` with an empty
 * failure reason and no record anywhere of what went wrong.
 *
 * Every method swallows its own I/O errors. A queue that cannot be written is a
 * degraded audit trail; an exception here would reach the tick loop.
 */
export class PendingStore {
  constructor(private readonly deps: PendingStoreDeps) {}

  async load(): Promise<PendingReport[]> {
    let raw: string | null;
    try {
      raw = await this.deps.read();
    } catch {
      return [];
    }
    if (!raw) return [];

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as PendingReport[];
    } catch {
      // A crash mid-write leaves a partial file. Starting with an empty queue
      // beats refusing to start.
      return [];
    }
  }

  async save(reports: PendingReport[]): Promise<void> {
    try {
      await this.deps.write(JSON.stringify(reports));
    } catch {
      // Nothing to do and nowhere to report it. Never rethrow: this is called
      // from the report path, which is called from the tick loop.
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest agent/src/pending-store.spec.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add agent/src/pending-store.ts agent/src/pending-store.spec.ts
git commit -m "feat(agent): persist undelivered reports across a restart"
```

---

### Task 8: Wire continuous upload, health and durable reports into the agent

Everything so far is standalone modules. This connects them to `Agent.tick()` and `AgentDeps`.

**Files:**
- Modify: `agent/src/agent.ts` — `AgentDeps.capture` (lines 26-48), `tick()` (lines 290-325), `report()` (lines 327-352), `flushPending()` (lines 424-435)
- Modify: `agent/src/main.ts` — the capture deps object literal (lines ~120-215)
- Test: `agent/src/agent.spec.ts` (append)

**Interfaces:**
- Consumes: `ContinuousUploader` (Task 5), `HealthTracker` (Task 6), `PendingStore` (Task 7), `CaptureSession.trackDirs()` (Task 3), the `prefix` now present in the start command payload (Task 4).
- Produces:
  - `AgentDeps.capture` gains `sweepUploads(prefix: string): Promise<void>` and `uploadHealth(): { queued: number; failures: number; oldestPendingMs: number | null }`
  - `AgentDeps.capture.states()` return type gains `health?: 'ok' | 'stalled' | 'quiet'`
  - The `progress` report body gains `upload_health` and each track entry gains `health`.

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/agent.spec.ts — append at end of file
describe('continuous upload during recording', () => {
  it('sweeps uploads on every tick while capture runs', async () => {
    const sweepUploads = jest.fn(async () => undefined);
    const deps = makeDeps({}, { sweepUploads, uploadHealth: () => ({ queued: 0, failures: 0, oldestPendingMs: null }) });
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 1 });

    await agent.handle({
      command_id: 'c1',
      type: 'start',
      session_id: 's',
      payload: { t0: new Date(Date.now() - 1000).toISOString(), prefix: 'sessions/2026/09/11/s' },
    });
    await agent.tick();

    expect(sweepUploads).toHaveBeenCalledWith('sessions/2026/09/11/s');
  });

  it('keeps ticking when a sweep throws, because capture outranks upload', async () => {
    // The rule the owner chose: an S3 outage must never stop a recording.
    const sweepUploads = jest.fn(async () => {
      throw new Error('minio unreachable');
    });
    const deps = makeDeps({}, { sweepUploads, uploadHealth: () => ({ queued: 3, failures: 2, oldestPendingMs: 90_000 }) });
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 1 });

    await agent.handle({
      command_id: 'c1',
      type: 'start',
      session_id: 's',
      payload: { t0: new Date(Date.now() - 1000).toISOString(), prefix: 'p' },
    });

    await expect(agent.tick()).resolves.toBeUndefined();
  });

  it('reports upload health so the console can alarm on it', async () => {
    const deps = makeDeps(
      {},
      {
        sweepUploads: jest.fn(async () => undefined),
        uploadHealth: () => ({ queued: 3, failures: 2, oldestPendingMs: 90_000 }),
      },
    );
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 1 });

    await agent.handle({
      command_id: 'c1',
      type: 'start',
      session_id: 's',
      payload: { t0: new Date(Date.now() - 1000).toISOString(), prefix: 'p' },
    });
    await agent.tick();

    const progress = deps.posted.filter((p) => p.path.endsWith('/progress')).pop();
    expect(progress?.body.upload_health).toEqual({ queued: 3, failures: 2, oldest_pending_ms: 90_000 });
  });

  it('carries per-track health in the progress report', async () => {
    const deps = makeDeps(
      {},
      {
        sweepUploads: jest.fn(async () => undefined),
        uploadHealth: () => ({ queued: 0, failures: 0, oldestPendingMs: null }),
        states: () => [
          { trackId: 't1', degraded: false, segments: 3, bytes: 3_000_000, health: 'ok' as const },
          { trackId: 't2', degraded: false, segments: 0, bytes: 500, health: 'stalled' as const },
        ],
      },
    );
    const agent = new Agent(deps, { agentId: 'a1', minFreeGb: 1 });

    await agent.handle({
      command_id: 'c1',
      type: 'start',
      session_id: 's',
      payload: { t0: new Date(Date.now() - 1000).toISOString(), prefix: 'p' },
    });
    await agent.tick();

    const progress = deps.posted.filter((p) => p.path.endsWith('/progress')).pop();
    expect(progress?.body.tracks).toEqual([
      { track_id: 't1', degraded: false, segments: 3, bytes: 3_000_000, health: 'ok' },
      { track_id: 't2', degraded: false, segments: 0, bytes: 500, health: 'stalled' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest agent/src/agent.spec.ts -t "continuous upload"`
Expected: FAIL — `sweepUploads` is never called; `upload_health` is absent from the progress body.

Note: `makeDeps` already merges `captureOverrides` into `capture` (see its comment at the top of the file). Add `sweepUploads` and `uploadHealth` to the default `capture` object in `makeDeps` so existing tests keep working.

- [ ] **Step 3: Write minimal implementation**

In `agent/src/agent.ts`, extend the `capture` dep:

```typescript
    /** Uploads closed segments for a running session. Never throws. */
    sweepUploads(prefix: string): Promise<void>;
    /** Queue depth and failure count for the continuous uploader. */
    uploadHealth(): { queued: number; failures: number; oldestPendingMs: number | null };
```

and widen `states()`:

```typescript
    states(): {
      trackId: string;
      degraded: boolean;
      segments: number;
      bytes: number;
      health?: 'ok' | 'stalled' | 'quiet';
    }[];
```

Store the prefix when `start` arrives (in the `start` handler, beside where `t0` is read):

```typescript
    // Sent by the API at start so segments can upload during the recording.
    this.uploadPrefix = (command.payload.prefix as string | undefined) ?? null;
```

with the field declared beside `sessionId`:

```typescript
  private uploadPrefix: string | null = null;
```

In `tick()`, sweep before reporting, and never let it escape:

```typescript
      if (this.uploadPrefix) {
        // Swallowed deliberately. Local media is the durable copy; a storage
        // outage must not reach ffmpeg or end the tick loop.
        await this.deps.capture
          .sweepUploads(this.uploadPrefix)
          .catch((error) => console.error('upload sweep failed:', (error as Error).message));
      }
```

and extend the progress body:

```typescript
      const upload = this.deps.capture.uploadHealth();

      await this.report(
        this.sessionId,
        {
          tracks: this.deps.capture.states().map((s) => ({
            track_id: s.trackId,
            degraded: s.degraded,
            segments: s.segments,
            bytes: s.bytes,
            health: s.health ?? 'ok',
          })),
          upload_health: {
            queued: upload.queued,
            failures: upload.failures,
            oldest_pending_ms: upload.oldestPendingMs,
          },
          free_disk_bytes: free,
          active_window: this.deps.capture.currentWindow(),
        },
        'progress',
      );
```

In `main.ts`, build the `ContinuousUploader` and `HealthTracker` alongside the existing session, and implement the two new deps. `sweepUploads` calls `session.trackDirs()` and the uploader; `uploadHealth` returns `uploader.health()`; `states()` merges `HealthTracker.observe(...)` into the existing rows. Wire `PendingStore` into the agent's `pending` array: load on startup, save after every push and every successful flush. Use `join(config.recordingDir, '.pending-reports.json')` — deliberately outside any session directory, so Discard's deletion never removes it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest agent/`
Expected: PASS — the four new tests plus every pre-existing agent test.

- [ ] **Step 5: Commit**

```bash
git add agent/src/agent.ts agent/src/main.ts agent/src/agent.spec.ts
git commit -m "feat(agent): sweep uploads and report capture health each tick"
```

---

### Task 9: Persist health on the API side

`reportProgress` (`src/sessions/sessions.service.ts:163-178`) writes `segmentCount`, `bytes` and `degraded`. It must carry the new health fields through to the console.

**Files:**
- Modify: `src/sessions/dto/session.dto.ts:57-77` (`TrackProgressDto`, `ProgressDto`)
- Modify: `src/sessions/entities/track.entity.ts` (add `health` column)
- Modify: `src/sessions/sessions.service.ts:163-178` (`reportProgress`), and `byId`'s `progress` block at lines 231-248
- Create: `src/database/migrations/<timestamp>-TrackHealth.ts`
- Test: `src/sessions/sessions.service.spec.ts` (append)

**Interfaces:**
- Consumes: the progress body from Task 8.
- Produces:
  - `Track.health: 'ok' | 'stalled' | 'quiet'`, column `text`, default `'ok'`
  - `SessionProgress` gains `stalled: number`, `quiet: number`, `upload: { queued: number; failures: number; oldestPendingMs: number | null } | null`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sessions/sessions.service.spec.ts — append at end of file
describe('capture health reaches the console', () => {
  it('persists per-track health from the progress report', async () => {
    const { service, tracksRepo } = makeService({ agents: ['a1'] });

    await service.reportProgress('s1', {
      agent_id: 'a1',
      tracks: [{ track_id: 't0', segments: 0, bytes: 500, degraded: false, health: 'stalled' }],
    } as never);

    const saved = tracksRepo.save.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(saved.health).toBe('stalled');
  });

  it('counts stalled and quiet tracks in the session progress', async () => {
    const { service, tracksRepo } = makeService({ agents: ['a1', 'a2'] });
    tracksRepo.find = jest.fn(async () => [
      { id: 't0', kind: 'audio', segmentCount: 0, bytes: '500', degraded: false, health: 'stalled', uploadState: 'pending' },
      { id: 't1', kind: 'audio', segmentCount: 3, bytes: '900', degraded: false, health: 'quiet', uploadState: 'pending' },
    ]) as never;

    const session = await service.byId('s1');

    expect(session.progress.stalled).toBe(1);
    expect(session.progress.quiet).toBe(1);
  });

  it('carries upload health through to the console', async () => {
    const { service } = makeService({ agents: ['a1'] });

    await service.reportProgress('s1', {
      agent_id: 'a1',
      tracks: [],
      upload_health: { queued: 4, failures: 2, oldest_pending_ms: 120_000 },
    } as never);

    const session = await service.byId('s1');
    expect(session.progress.upload).toEqual({
      queued: 4,
      failures: 2,
      oldestPendingMs: 120_000,
    });
  });

  it('defaults health to ok when an older agent omits it', async () => {
    // A host running last week's agent build must not read as stalled.
    const { service, tracksRepo } = makeService({ agents: ['a1'] });

    await service.reportProgress('s1', {
      agent_id: 'a1',
      tracks: [{ track_id: 't0', segments: 2, bytes: 1000, degraded: false }],
    } as never);

    const saved = tracksRepo.save.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(saved.health ?? 'ok').toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/sessions/sessions.service.spec.ts -t "capture health"`
Expected: FAIL — `health` is not persisted and `progress.stalled` is undefined.

- [ ] **Step 3: Write minimal implementation**

Add to `TrackProgressDto`:

```typescript
  @IsOptional() @IsIn(['ok', 'stalled', 'quiet']) health?: string;
```

Add to `ProgressDto`:

```typescript
  @IsOptional() @ValidateNested() @Type(() => UploadHealthDto)
  upload_health?: UploadHealthDto;
```

with:

```typescript
export class UploadHealthDto {
  @IsInt() @Min(0) queued!: number;
  @IsInt() @Min(0) failures!: number;
  @IsOptional() @IsInt() @Min(0) oldest_pending_ms?: number | null;
}
```

Add to `Track`:

```typescript
  /**
   * Capture health while recording: a track whose ffmpeg is alive but writing
   * nothing reads `ok` from `degraded`, which only flips on process exit.
   */
  @Column({ type: 'text', default: 'ok' })
  health!: 'ok' | 'stalled' | 'quiet';
```

In `reportProgress`, persist it and hold upload health in memory beside `freeDisk`:

```typescript
      track.health = (update.health as Track['health']) ?? track.health ?? 'ok';
```

```typescript
    if (dto.upload_health) {
      this.uploadHealth.set(sessionId, {
        queued: dto.upload_health.queued,
        failures: dto.upload_health.failures,
        oldestPendingMs: dto.upload_health.oldest_pending_ms ?? null,
      });
    }
```

In `byId`'s `progress` block:

```typescript
        stalled: tracks.filter((t) => t.health === 'stalled').length,
        quiet: tracks.filter((t) => t.health === 'quiet').length,
        upload: this.uploadHealth.get(sessionId) ?? null,
```

Generate the migration offline — never `prisma migrate dev`, and this repo is TypeORM:

```bash
npx typeorm-ts-node-commonjs migration:generate src/database/migrations/TrackHealth -d src/database/data-source.ts
```

If that data-source path does not exist, read `src/database/` and follow the pattern of `1757200000000-InitialSchema.ts`, writing the migration by hand: `ALTER TABLE "tracks" ADD COLUMN "health" text NOT NULL DEFAULT 'ok'` with the matching `down`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/`
Expected: PASS — the four new tests plus every pre-existing API test.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/dto/session.dto.ts src/sessions/entities/track.entity.ts src/sessions/sessions.service.ts src/sessions/sessions.service.spec.ts src/database/migrations/
git commit -m "feat(api): persist per-track capture health and upload health"
```

---

### Task 10: Discard deletes the session's objects

The one new deletion path, guarded tightly because this code runs against unrepeatable media.

**Files:**
- Create: `agent/src/upload/purge.ts`
- Test: `agent/src/upload/purge.spec.ts`
- Modify: `agent/src/upload/uploader.ts` — add `remove` and `list` to the `S3Like` returned by `s3Client` (`list` already exists; add `remove`)
- Modify: `agent/src/agent.ts` — the `abort` handler at lines ~281-285
- Modify: `agent/src/main.ts` — implement a `purgeUploads` capture dep

**Interfaces:**
- Consumes: `S3Like.list(prefix)` (already exists in `uploader.ts:153`).
- Produces:
  - `S3Like` gains `remove(key: string): Promise<void>`
  - `interface PurgeDeps { list(prefix: string): Promise<string[]>; remove(key: string): Promise<void> }`
  - `function purgePrefix(deps: PurgeDeps, prefix: string): Promise<number>` — returns the count deleted
  - `AgentDeps.capture` gains `purgeUploads(prefix: string): Promise<number>`
  - `Agent.abort` changes from `abort(): Promise<void>` to `abort(command?: Command): Promise<void>`

**Call site that must change with the signature:** `agent/src/agent.ts:121`
currently reads `return this.abort();` inside the `handle` dispatcher. It must
become `return this.abort(command);`, or the prefix never reaches the purge and
Discard silently deletes nothing.

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/upload/purge.spec.ts
import { purgePrefix, PurgeDeps } from './purge';

function makeDeps(keys: string[]): PurgeDeps & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    list: jest.fn(async () => keys),
    remove: jest.fn(async (key: string) => {
      removed.push(key);
    }),
  } as PurgeDeps & { removed: string[] };
}

describe('purgePrefix', () => {
  it('deletes every object under the session prefix', async () => {
    const deps = makeDeps([
      'sessions/2026/09/11/s1/manifest.json',
      'sessions/2026/09/11/s1/alfares/screen-HDMI-A-0/seg-00000.mp4',
    ]);

    const count = await purgePrefix(deps, 'sessions/2026/09/11/s1');

    expect(count).toBe(2);
    expect(deps.removed).toHaveLength(2);
  });

  it('refuses a prefix that is not a single session', async () => {
    // The guard that matters. `sessions/2026` would delete a month of work,
    // and this function is the only delete path in the service.
    const deps = makeDeps(['sessions/2026/09/11/s1/manifest.json']);

    await expect(purgePrefix(deps, 'sessions/2026')).rejects.toThrow(/not a session prefix/);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('refuses an empty prefix', async () => {
    const deps = makeDeps([]);
    await expect(purgePrefix(deps, '')).rejects.toThrow(/not a session prefix/);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('never deletes a key from outside the prefix it was given', async () => {
    // A defensive second check: if list ever returned something broader, the
    // blast radius must still be one session.
    const deps = makeDeps([
      'sessions/2026/09/11/s1/manifest.json',
      'sessions/2026/09/11/s2/manifest.json',
    ]);

    await purgePrefix(deps, 'sessions/2026/09/11/s1');

    expect(deps.removed).toEqual(['sessions/2026/09/11/s1/manifest.json']);
  });

  it('succeeds when there is nothing to delete', async () => {
    const deps = makeDeps([]);
    expect(await purgePrefix(deps, 'sessions/2026/09/11/s1')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest agent/src/upload/purge.spec.ts`
Expected: FAIL — `Cannot find module './purge'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// agent/src/upload/purge.ts

export interface PurgeDeps {
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}

/** `sessions/YYYY/MM/DD/<session-id>` and nothing shallower. */
const SESSION_PREFIX = /^sessions\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}$/;

/**
 * Deletes every object belonging to one discarded session.
 *
 * This is the only code in the service that deletes stored media, and it exists
 * because continuous upload puts objects in the bucket before the operator has
 * decided to keep them. Discard is an explicit operator request, which is what
 * the retention rules require of a deletion path.
 *
 * The prefix shape is checked rather than trusted: the difference between one
 * session and a month of them is a few characters.
 */
export async function purgePrefix(deps: PurgeDeps, prefix: string): Promise<number> {
  if (!SESSION_PREFIX.test(prefix)) {
    throw new Error(`refusing to purge: ${prefix || '(empty)'} is not a session prefix`);
  }

  const keys = (await deps.list(prefix)).filter((key) => key.startsWith(`${prefix}/`));

  for (const key of keys) {
    await deps.remove(key);
  }

  return keys.length;
}
```

Add `remove` to the `S3Like` interface and to the real client in `uploader.ts`:

```typescript
  /** Deletes one object. Used only by the discard path. */
  remove(key: string): Promise<void>;
```

```typescript
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
```

importing `DeleteObjectCommand` from `@aws-sdk/client-s3`.

In `agent/src/agent.ts`, extend the abort handler to purge when the API supplied a prefix:

```typescript
  private async abort(command?: Command): Promise<void> {
    if (this.deps.capture.isRunning()) await this.deps.capture.stop();

    const prefix = command?.payload.prefix as string | undefined;
    if (prefix) {
      // Local media is untouched -- Discard has never deleted it and still does
      // not. Only the objects continuous upload already wrote are removed.
      await this.deps.capture
        .purgeUploads(prefix)
        .then((count) => log(`purged ${count} uploaded objects for a discarded session`))
        .catch((error) => console.error('purge failed:', (error as Error).message));
    }

    this.uploadPrefix = null;
    this.sessionId = null;
  }
```

and have `discard()` on the API side include the prefix in the Abort payload (`src/sessions/sessions.service.ts`, in `discard`):

```typescript
      await this.commands.queue(agentId, CommandType.Abort, sessionId, {
        prefix: session.s3Prefix ?? undefined,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest`
Expected: PASS — full suite, well above the 440 baseline.

- [ ] **Step 5: Commit**

```bash
git add agent/src/upload/purge.ts agent/src/upload/purge.spec.ts agent/src/upload/uploader.ts agent/src/agent.ts agent/src/main.ts src/sessions/sessions.service.ts
git commit -m "feat(agent): delete uploaded objects when a session is discarded"
```

---

### Task 11: The console alarm banner

Render the three alarms so they cannot be missed, and stop the console showing reassuring copy beside an active alarm.

**Files:**
- Modify: `public/index.html` — add a banner element to the recording screen, above the track table
- Modify: `public/app.js` — `pollSession`/`renderTracks` (lines ~247-340), `loadSessions` (lines ~455-480)
- Modify: `public/style.css` — banner styles (read the file for existing custom-property names before adding)
- Test: `src/ui/console-wiring.spec.ts` (append)

**Interfaces:**
- Consumes: `session.progress.stalled`, `session.progress.quiet`, `session.progress.upload`, `track.health` from Task 9.
- Produces: no new module exports; DOM ids `capture-alarm` and `alarm-detail`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/ui/console-wiring.spec.ts — append at end of file
describe('the recording screen alarms when capture or upload is failing', () => {
  it('declares the banner in the page', () => {
    expect(html).toContain('id="capture-alarm"');
    expect(html).toContain('id="alarm-detail"');
  });

  it('drives the banner from the health the API reports', () => {
    // A track whose ffmpeg is alive but writing nothing looked healthy for a
    // whole 21-minute session.
    expect(app).toContain("$('capture-alarm')");
    expect(app).toMatch(/progress\.stalled/);
    expect(app).toMatch(/progress\.upload/);
  });

  it('names the failing track rather than only counting them', () => {
    // "1 track stalled" sends the operator hunting; the source ref does not.
    const fn = app.slice(app.indexOf('function renderAlarm'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/sourceRef/);
  });

  it('renders a stalled track distinctly in the track table', () => {
    const fn = app.slice(app.indexOf('function renderTracks'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/stalled/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/ui/console-wiring.spec.ts -t alarms`
Expected: FAIL — `id="capture-alarm"` is not in the page and `renderAlarm` does not exist.

- [ ] **Step 3: Write minimal implementation**

Add to `public/index.html` inside the recording section, above the track table:

```html
        <div id="capture-alarm" class="alarm" hidden>
          <strong id="alarm-headline">Capture problem</strong>
          <p id="alarm-detail"></p>
        </div>
```

Add `renderAlarm(session)` to `public/app.js`, called from `pollSession` beside `renderTracks(session)`:

```javascript
/**
 * The loud path. A track whose ffmpeg is alive but writing nothing reports
 * healthy through `degraded`, which only flips when the process exits -- so a
 * 21-minute session captured 914 KB on one microphone and said nothing.
 *
 * Upload trouble is shown but never framed as data loss: the local files are
 * the durable copy and the recording is still safe.
 */
function renderAlarm(session) {
  const p = session.progress || {};
  const tracks = session.tracks || [];
  const banner = $('capture-alarm');

  const stalled = tracks.filter((t) => t.health === 'stalled');
  const quiet = tracks.filter((t) => t.health === 'quiet');
  const dead = tracks.filter((t) => t.degraded);
  const upload = p.upload || null;
  const uploadStuck = upload && (upload.failures > 0 || (upload.oldestPendingMs || 0) > 120000);

  const messages = [];
  if (dead.length) {
    messages.push(`Capture stopped: ${dead.map((t) => t.sourceRef).join(', ')}.`);
  }
  if (stalled.length) {
    messages.push(`Capturing nothing: ${stalled.map((t) => t.sourceRef).join(', ')}.`);
  }
  if (quiet.length) {
    messages.push(`Very quiet, check the input: ${quiet.map((t) => t.sourceRef).join(', ')}.`);
  }
  if (uploadStuck) {
    messages.push(
      `Upload is behind: ${upload.queued} segments waiting. The recording is safe on disk.`,
    );
  }

  banner.hidden = messages.length === 0;
  banner.classList.toggle('critical', dead.length > 0 || stalled.length > 0);
  $('alarm-detail').textContent = messages.join(' ');
}
```

Extend `renderTracks`'s status expression so `stalled` and `quiet` render distinctly, and give affected rows a class. In `loadSessions`, add a red class to rows whose session state is `failed`.

Add to `public/style.css`:

```css
.alarm {
  border: 2px solid #b34; background: #2a1418; color: #fdd;
  padding: 12px 16px; border-radius: 6px; margin-bottom: 16px;
}
.alarm.critical { border-color: #f44; background: #3a1216; }
.alarm strong { display: block; margin-bottom: 4px; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest`
Expected: PASS — the four new tests plus the full suite.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/style.css src/ui/console-wiring.spec.ts
git commit -m "feat(console): alarm when a track stops capturing or upload falls behind"
```

---

### Task 12: Amend the documentation this work changes

Three written contracts are contradicted by the code now in place. Amend them explicitly, and record the IPS chain.

**Files:**
- Modify: `SYSTEM.md:72-81` (state machine section)
- Modify: `docs/06_architecture/INTEGRATION_CONTRACT.md` (MinIO API section, the `DeleteObject` line)
- Modify: `docs/superpowers/specs/2026-09-06-screencast-recorder-design.md` (the `review` gate paragraph)
- Modify: `TASKS.md` (move this work out of "Ready next")
- Create: `docs/11_tasks/TASK-003-continuous-upload-and-alarms.md`
- Create: `docs/22_goal_impact/GOAL-IMPACT-TASK-003.md`
- Modify: `STATE.json` (`planning.status`, `last_updated_at`)

**Interfaces:**
- Consumes: the spec at `docs/superpowers/specs/2026-09-11-continuous-upload-and-capture-alarms-design.md`.
- Produces: no code.

- [ ] **Step 1: Amend `SYSTEM.md`**

Leave the state diagram unchanged and add beneath it:

```markdown
Per-track upload begins during `recording`: the agent uploads each 60-second
segment as soon as a successor file proves it closed, and tracks that progress
in `tracks.upload_state`. The session states above are unchanged, and `stored`
still requires the operator's Save and the API's independent verification.
```

- [ ] **Step 2: Amend the MinIO contract**

In `docs/06_architecture/INTEGRATION_CONTRACT.md`, replace the `DeleteObject` bullet:

```markdown
- DeleteObject under an explicit retention operation. In phase 1 there is
  exactly one: Discard, which removes the objects continuous upload wrote for a
  session the operator rejected. It is performed by the agent, scoped to that
  session's prefix, and never touches local media.
```

- [ ] **Step 3: Supersede the review-gate paragraph**

In `docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`, after the `review` gate sentence, add:

```markdown
> **Superseded 2026-09-11** by
> [`2026-09-11-continuous-upload-and-capture-alarms-design.md`](2026-09-11-continuous-upload-and-capture-alarms-design.md):
> bytes now reach S3 during recording, so a crash loses seconds rather than
> hours. The gate still exists and still requires an operator decision — what it
> gates is publication (`session.stored`), not the movement of bytes.
```

- [ ] **Step 4: Write the task and goal-impact records**

Create `docs/11_tasks/TASK-003-continuous-upload-and-alarms.md` and
`docs/22_goal_impact/GOAL-IMPACT-TASK-003.md`, following the frontmatter and
section shape of `TASK-001-bootstrap-service.md` and `GOAL-IMPACT-TASK-001.md`
exactly. Upstream links: `BUSINESS.md`, `SYSTEM.md`, `docs/01_vision/VISION.md`,
and the 2026-09-11 spec. Update `TASKS.md` and `STATE.json` to match.

- [ ] **Step 5: Commit**

```bash
git add SYSTEM.md TASKS.md STATE.json docs/
git commit -m "docs: record continuous upload, discard deletion and capture alarms"
```

---

## Validation

Unit tests do not prove this works. The 2026-09-10 incident passed 434 tests.
Before calling this done, record evidence in
`docs/12_validation/VAL-TASK-003-continuous-upload-and-alarms.md`, following
`VAL-TASK-001-bootstrap-service.md`:

1. **A real recording uploads while it runs.** Start a session, wait three
   minutes, and list the bucket prefix before pressing Stop. Objects must
   already be there. Record the count and the elapsed time.
2. **Save is fast.** Time it. It should be seconds, against ~3m12s before.
3. **A pulled microphone alarms.** Unplug an audio source mid-recording and
   confirm the banner names that source within ~15 seconds.
4. **An upload outage does not stop capture.** Scale MinIO to zero replicas for
   60 seconds mid-recording. The recording must continue, the banner must say
   upload is behind, and the queued segments must upload when it returns.
5. **Discard removes the objects.** Record briefly, discard, and confirm the
   prefix is empty and the local files are still present.
6. **The console alarm is visible in a browser.** The only console harness reads
   `app.js` as text; it cannot see a banner that renders white-on-white or
   off-screen. Look at it.
