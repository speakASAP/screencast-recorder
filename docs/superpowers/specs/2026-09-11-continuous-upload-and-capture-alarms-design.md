# Continuous upload and capture alarms

```yaml
id: DESIGN-continuous-upload-and-capture-alarms
status: approved
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-11
last_updated: 2026-09-11
completeness_level: complete
supersedes_in_part:
  - docs/superpowers/specs/2026-09-06-screencast-recorder-design.md
amends:
  - SYSTEM.md
  - docs/06_architecture/INTEGRATION_CONTRACT.md
```

## Why

On 2026-09-10 a 21-minute session uploaded 90 objects to MinIO — 88 media
segments, `events.jsonl` and `manifest.json`, covering all 89 keys the API
verifies — read every one of them back, and was then stranded. The agent's
`upload-complete` call threw, its failure report also failed to deliver, and the
session sat in `uploading` for ever: tracks `pending`, console reading "0 of 5
tracks verified" indefinitely. The bytes were safe the whole time. Only the
bookkeeping was lost.

That incident exposed three separate weaknesses, and the owner added a fourth
requirement on top of them.

1. **Nothing reaches S3 until Save.** A crash at minute 59 of an hour-long
   session loses the hour. Today's upload begins only when the operator clicks.
2. **A silent track is invisible.** In the same session,
   `audio-...HiFi__hw_Audio_1__source` captured 914 KB while its sibling
   captured 31 MB. `degraded` flips only when ffmpeg *exits*; a live process
   producing near-nothing reports healthy for the full recording.
3. **A failed save is silent.** The agent's failure report is queued to an
   in-memory array and dies with the process.
4. **The owner must be told, loudly, while recording, when capture or upload is
   not working.** The owner is always at the monitor during a recording.

## What this is not

This does not make recording depend on S3. Local media stays authoritative
(`AGENTS.md` rule 8). Upload failure never stops, pauses, or degrades capture.
That was explicitly considered and rejected: a transient S3 outage must not
destroy an unrepeatable take. The protection against recording into a void is a
loud alarm, not a halt.

## Rules this changes

Three written contracts are contradicted by the work below. Each is amended
deliberately rather than quietly broken.

### The review gate moves from "nothing uploads" to "nothing is published"

`2026-09-06-screencast-recorder-design.md` states: *"`review` is the
save/discard gate: recording has stopped, files are still local, and nothing
reaches S3 until the operator decides."*

Continuous upload ends that guarantee. The replacement:

> Bytes may reach S3 during recording. Nothing is **published** — no
> `session.stored`, no phase-2 handoff, no `stored` state — until the operator
> saves.

The gate still exists and still requires an explicit operator decision. What it
gates is the session's promotion to durable, announced, editable material, not
the movement of bytes. The phase-2 chain's precondition is unchanged: it keys on
`session.stored`, which only Save can produce.

### Discard becomes an explicit retention operation

`INTEGRATION_CONTRACT.md` permits `DeleteObject` *"only under an explicit future
retention operation"*, and the design doc says phase 1 *"never deletes anything
automatically"* with raw footage deleted on exactly two explicit paths.

Discard is now a third path. It qualifies on both documents' own terms — it is
an explicit operator request, not an automatic consequence — but the contract
must say so. Amendment:

> Discard is an explicit retention operation. When the operator discards a
> session, the agent deletes that session's objects under its own prefix. No
> other deletion path exists in phase 1.

No credential widens: the provisioned `screencast-rw` policy already grants
`s3:DeleteObject`, and the agent already holds it. The API's `StorageService`
stays read-only, as designed.

### The session state machine is untouched

`SYSTEM.md` documents `preparing → recording → stopping → review → uploading →
stored`. Upload now overlaps `recording`, which appears to break that sequence.

It does not, because **continuous upload is tracked per track, not per session.**
`tracks.upload_state` already exists and already carries per-track upload status.
Session states keep their exact current meanings; `uploading` continues to mean
"the operator saved and the final objects are going up". SYSTEM.md gains a note
that per-track upload begins during `recording`, and the state diagram is
unchanged.

This is deliberate. The state machine is explicitly defended in
`session.entity.ts` as enumerated rather than inferred, because the review gate
is a product requirement. Restructuring it to express continuous upload would
put that gate at risk for no gain.

## Design

### 1. Continuous upload

**Eligibility.** ffmpeg writes 60-second segments. A segment file is closed and
immutable once a higher-numbered sibling exists in the same directory. On each
5-second tick the agent lists each track directory and treats every file except
the highest-numbered one as eligible. The file currently being written is never
read.

**Prefix timing.** `s3Prefix` is currently fixed at Save
(`sessions.service.ts:200`), specifically so a session crossing midnight is not
verified against a prefix nothing was written to. Continuous upload forces the
decision earlier: the prefix is computed when the session enters `recording`,
persisted then, and carried in the start command's payload. This is strictly
safer than today — the prefix derives from `startedAt`, which is exactly what
the existing comment wants to protect — and Save reuses the stored value rather
than recomputing it.

**Queue.** A per-agent upload queue with bounded concurrency of 3 parallel PUTs,
drained from the existing tick loop. Failures retry with the existing backoff
and remain queued. The queue never blocks ffmpeg, never blocks the tick, and
never blocks a stop.

**Idempotence is already solved.** `Uploader.uploadFile` skips any object
already present at the expected size (`upload/uploader.ts:64`). A resumed or
repeated upload costs one HEAD per object and transfers nothing.

**What Save becomes.** At Save, most objects are already stored. The agent
uploads only what remains — the final segment of each track, `events.jsonl`,
`manifest.json` — then posts `upload-complete` as it does today. The API's
independent verification is unchanged and remains the sole authority for
`stored`. Save drops from minutes to seconds.

**Parallelism fixes the old slowness too.** Today's serial PUT loop plus serial
HEAD verify is 180 sequential round trips to an external HTTPS endpoint, which
measured ~850 KB/s for 162 MB. Both passes become concurrent.

### 2. Discard deletes S3 objects

On Abort, the agent deletes every object under the session's own prefix, then
reports completion. Guards, because this is the only delete path in a system
that records unrepeatable media:

- scoped to `<prefix>/` for that one session id, never a parent prefix;
- refuses unless the session state is `discarded`;
- local files are untouched, exactly as today — Discard has never deleted local
  media and still does not.

### 3. The three alarms

All three ride the existing 5-second progress report and the console's
2-second poll. Worst-case detection is about 7 seconds.

**Alarm 1 — capture dead.** Already plumbed end to end: `CaptureSupervisor`
marks `degraded` on abnormal ffmpeg exit (`supervisor.ts:60`), the agent ships
it every tick, the API persists it, the console renders it in a table cell. Only
the presentation is missing.

**Alarm 2 — capture silent.** New. The agent tracks bytes-per-tick per track.

- `stalled`: zero new bytes across 3 consecutive ticks (15s) while at least one
  other track advances. Unambiguous, and blocking-grade in the UI.
- `quiet`: an audio track's byte rate under a floor for a sustained window.
  Soft warning only.

The `quiet` floor is deliberately not fixed in this spec. A genuinely silent
room produces a legitimately small AAC stream, and the threshold that separates
"muted device" from "nobody is talking" is not known. It ships as a warning,
with the floor tuned against a real recording before it is given any more
weight. `stalled` carries the guarantee; `quiet` is advisory until it earns
more.

**Alarm 3 — upload failing.** New per-session upload health: queue depth, age of
the oldest un-uploaded segment, consecutive failure count. Surfaces as a banner.
Never blocks recording.

**Presentation.** A persistent banner at the top of the recording screen, red,
naming the specific track and what is wrong. Affected sessions render red in the
Sessions list. The console shows no reassuring language while any alarm is
active. No sound and no push notification: the owner is at the monitor.

### 4. Durable failure reporting

The incident's root harm was a failure report that lived only in memory. The
agent's pending-report queue is written to disk under the session directory and
replayed on startup, so a report survives the process. This is small, and it is
the difference between a stranded session that explains itself and one that does
not.

## Testing

- **Eligibility** — a directory of segments yields every file but the highest;
  an empty directory yields nothing; a single segment yields nothing.
- **Idempotence** — re-running an upload over already-present objects transfers
  nothing and reports success.
- **Prefix at start** — a session started before midnight and saved after it
  verifies against the prefix its bytes were written to. This is the bug the
  original Save-time comment was written to prevent; it now needs a test at the
  new timing.
- **Discard deletion** — deletes under the session prefix only; refuses when the
  session is not `discarded`; leaves local files in place.
- **Stall detection** — a track producing no bytes while others advance is
  marked `stalled`; a track producing bytes is not; the first tick of a session
  never false-alarms.
- **Report durability** — a queued report written before a simulated restart is
  replayed after it.
- **Console** — the banner renders for each alarm kind; no reassuring copy is
  shown while an alarm is active.

The console's only harness is `src/ui/console-wiring.spec.ts`, which reads
`public/app.js` as text. That is weaker than behavioural coverage and should be
acknowledged as such: it catches dead controls and missing ids, not wrong
behaviour. Alarm presentation needs at least one real browser check before this
work is called done.

## Sequencing

1. ~~Console fix~~ — shipped in `ef544f2`: review fields populate on resume, the
   upload poll gives up after 60s without progress, the lede follows session
   state.
2. **Un-strand session `58a55432`** — blocked on operator action; the DB write
   was denied to the agent. All 89 expected objects are confirmed present in
   MinIO at non-zero size.
3. **Continuous upload** — prefix at start, eligibility, concurrent queue, Save
   reuses what is already up.
4. **Discard deletes S3** — agent-side, prefix-scoped, state-guarded.
5. **Durable failure reports** — disk-backed pending queue.
6. **Alarms** — health fields, progress plumbing, console presentation.
7. **Doc amendments** — `SYSTEM.md` per-track upload note;
   `INTEGRATION_CONTRACT.md` discard-as-retention-operation clause; supersession
   note in the 2026-09-06 design; TASK, GOAL-IMPACT and VAL records per the IPS
   chain.

Items 3–6 are one coherent change and share a single task record.

## Rejected alternatives

**Stop recording on sustained upload failure.** The owner initially chose this,
then withdrew it once it was clear that nothing streams to S3 today and that
local disk is the durable copy. It converts "backup temporarily behind" into
"primary destroyed": the 2026-09-10 incident would have killed the take it
actually preserved.

**Give the API delete permission for Discard.** Rejected in favour of the agent
doing it. The agent already holds `s3:DeleteObject`; routing deletion through
the API would widen a credential that `CONSTITUTION.md` §8 scopes deliberately
narrow, and would make `StorageService` read-write when its read-only shape is
load-bearing.

**A bucket lifecycle rule to expire discarded prefixes.** Keeps the API
read-only, but leaves discarded objects lingering for the rule's window and puts
the semantics in MinIO's configuration rather than in this service, which owns
them.

**Restructuring the session state machine to model continuous upload.** Per-track
`upload_state` already carries the information. Reshaping a state machine that
exists to defend the review gate, in order to express something an existing
column already expresses, is risk without benefit.
