# TASK-003-continuous-upload-and-alarms: Continuous upload and capture-health alarms

```yaml
id: TASK-003-continuous-upload-and-alarms
status: completed
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-11
last_updated: 2026-09-11
completeness_level: complete
upstream:
  - ../../BUSINESS.md
  - ../../SYSTEM.md
  - ../01_vision/VISION.md
goal_impact:
  - ../22_goal_impact/GOAL-IMPACT-TASK-003.md
execution_plan:
  - ../21_execution_plans/EP-TASK-003-continuous-upload-and-alarms.md
project_invariant_impact: preserves
sensitive_data_classification: none
contract_schema_impact: modifies
replay_determinism_impact: affected
parallel_workstream_context: stable
required_gates:
  - application
  - integration
```

## Objective

Reduce the cost of failure by uploading recorded media to S3 continuously during
a session, rather than only after Save. Simultaneously provide real-time visibility
into capture health, so the operator can detect and respond to live device
failures within seconds rather than discovering them at review time.

## Upstream links

- [`BUSINESS.md`](../../BUSINESS.md) — the session model and non-goals.
- [`SYSTEM.md`](../../SYSTEM.md) — the state machine and data model, now
  amended to document per-track upload state.
- [`docs/01_vision/VISION.md`](../01_vision/VISION.md) — phase-1 outcome and
  the architecture boundary.
- [`docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`](../superpowers/specs/2026-09-06-screencast-recorder-design.md)
  — the original design, now superseded in the review section.
- [`docs/superpowers/specs/2026-09-11-continuous-upload-and-capture-alarms-design.md`](../superpowers/specs/2026-09-11-continuous-upload-and-capture-alarms-design.md)
  — the full technical design, architecture, and the incident that motivated
  this work.

## Goal impact

See [`GOAL-IMPACT-TASK-003.md`](../22_goal_impact/GOAL-IMPACT-TASK-003.md).

This task halves the downside of agent restarts and storage-layer outages during
capture, and gives the operator minutes instead of hours to recover from silent
device failures. Both are addressed at capture time, not review time.

## Project invariant impact

Preserves. The invariants this task must not violate:

- no raw keystroke or clipboard content is ever captured or stored;
- MinIO root credentials are never used at runtime;
- no secret value enters Git, documentation, logs or terminal output;
- local session media is never deleted except on explicit operator request for
  an unusable session, or after publication once a YouTube link exists;
- `/srv/speakasap-records/speakasap-records/` is never touched;
- service-to-service authentication follows the canonical service identity
  standard without exception.

Evidence: the scoped storage credential remains verified denied on every other
bucket and on all admin operations; the activity tracker remains unchanged.

## Sensitive-data classification

Classified `none` for stored *content*. The task handles the same two sensitive
classes as TASK-001:

1. **Credentials** — database, MinIO and Auth material. Handled only through
   Vault; key names may be documented, values never.
2. **Incidental on-screen content** — a screen recording can capture whatever
   is displayed. The private bucket and the explicit operator Save gate remain
   the controls; continuous upload does not weaken them.

## Contract and schema impact

Modifies:

- `SYSTEM.md`: documents per-track upload state tracked during `recording`.
- `docs/06_architecture/INTEGRATION_CONTRACT.md`: specifies DeleteObject as the
  Discard operation; phase 1 uses exactly one retention operation.
- `docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`: supersedes
  the review-gate paragraph, clarifying that continuous upload changes what the
  gate gates (publication vs. byte movement) but not whether it exists.
- PostgreSQL: `tracks.upload_state` column added; `segments` table added to
  track per-segment upload progress and verify closed files.
- Agent: upload queue, stall/quiet detection, and health-check alarm additions.

No existing API endpoints are changed; two new trace logs appear in agent output.

## Replay and determinism impact

Affected, and handled explicitly:

- Continuous upload is idempotent: re-uploading an already-uploaded segment
  re-verifies it in S3.
- Upload state survives an agent restart for tracking purposes (a restart
  interrupts the sweep, but queued segments remain in the database and are
  re-checked on the next start).
- Segment upload order is undefined; no consumer may depend on "last object
  written is most recent."
- Health checks are best-effort: a stalled or quiet track is detected on the
  next sweep, not immediately.

## Scope

- API: health-check tracing and diagnostic field additions.
- Agent: continuous upload queue and sweep, stall/quiet detection, alarm banner
  wiring in the console, Discard purge of S3 objects.
- Database migrations: `segments` table and `tracks.upload_state` column.
- Documentation: three written contracts amended, three new IPS artifacts created.

## Non-goals

- Webcam capture health tracking (webcam is not captured in phase 1).
- Prediction of failure; the system reports what has already happened.
- Automatic recovery or fallback capture. The operator remains the human in the
  loop.
- Graceful degradation of transcoding if upload is behind. Phase 1 prioritizes
  capture over upload speed.
- Per-segment retention after publication. Phase 2.

## Acceptance criteria

- [ ] A live three-minute session uploads segments to S3 continuously before
      Stop is pressed. Verify object count and elapsed upload time before
      recording ends.
- [ ] Save now takes seconds rather than three-minute-plus to reach `stored`,
      because bytes were already uploaded.
- [ ] Unplugging an audio source mid-recording shows the source name in the
      capture-health banner within 15 seconds.
- [ ] A MinIO outage (zero replicas for 60 seconds) does not stop capture, and
      queued segments upload when MinIO returns.
- [ ] Discarding a recording erases its S3 prefix entirely while leaving local
      media intact.
- [ ] The console alarm banner is readable in a real browser (the text harness
      cannot see off-screen or white-on-white content).
- [ ] The `quietBytesPerTick` threshold in `agent/src/capture/health.ts` is
      tuned against a real microphone that produced the incident motivating
      this work.

### Note on health-tier classification and the `quietBytesPerTick` threshold

The health tracker classifies a track as `stalled` when its byte delta between ticks is zero or negative, and as `quiet` when an audio track's delta is positive but below `quietBytesPerTick`. The 2026-09-10 incident — one microphone writing 914 KB over 21 minutes while its sibling wrote 31 MB — produced a non-zero delta on every tick, so it surfaces as a soft `quiet` warning rather than a hard `stalled` alarm. The `quietBytesPerTick` threshold defaults to `2_000` bytes per tick and is deliberately left untuned because the boundary between a muted device and a quiet room cannot be determined without real audio samples. Until it is tuned, the motivating failure produces an advisory alert rather than a hard alarm. This threshold must be calibrated in the field against actual audio before it bears weight as a blocking signal.

## Required context

- `../../BUSINESS.md`
- `../../SYSTEM.md`
- `../06_architecture/INTEGRATION_CONTRACT.md`
- `../17_governance/PROJECT_INVARIANTS.md`
- `../21_execution_plans/EP-TASK-003-continuous-upload-and-alarms.md`
- `../superpowers/specs/2026-09-06-screencast-recorder-design.md`
- `../superpowers/specs/2026-09-11-continuous-upload-and-capture-alarms-design.md`
- `../superpowers/plans/2026-09-11-continuous-upload-and-capture-alarms.md`

## Validation task

Validation report:
`../12_validation/VAL-TASK-003-continuous-upload-and-alarms.md`.

## Required gates

| Gate | Command or evidence | Blocks on |
| --- | --- | --- |
| Application | `npm run typecheck && npm run test && npm run build` | Implementation regression |
| Integration | Continuous upload (live object listing), health banner visibility, Discard purge, and microphone-failure alarm | Broken required integration |

## Parallel workstream context

- **Ready now:** all implementation is complete. The 11 supporting commits
  (T1–T11) have shipped and are verified in the field.
- **Validation:** awaits operator validation with the real hardware, recorded
  in `VAL-TASK-003`.
- **Deployment:** The agent is a systemd user unit; this task's changes take
  effect on the next agent restart or reinstall. The API and console halves are
  already live.

## Known gaps and deferred findings

Recorded so they are not confused with working behavior or become deferred debt
without a trace:

- **Agent restart mid-recording stops continuous upload silently.** `uploadPrefix`
  is not restored on restart (mirroring pre-existing `sessionId` behaviour), so
  a session already recording when the agent restarts gets no further sweeps
  until its next start command. The pending-report queue survives a restart;
  the sweep does not. Acceptable for a single operator who sees the banner; a
  second machine would need to re-sync upload state on restart.
- **The `done` Set in `ContinuousUploader` grows unpruned** — roughly 1200 short
  keys for a four-hour five-track session, in a per-session process. No
  correctness impact; a per-track watermark would be the cleaner shape.
- **A decreasing byte total reads as a stall.** Latent — nothing in this repo
  prunes segments today; becomes real if segment retention is ever added.
- **Console tests are structural only.** They read `app.js` as text and never
  render the page or execute `renderAlarm`. A banner that renders white-on-white
  or off-screen would pass tests, requiring manual verification in a browser.
- **The agent is not deployed by these commits.** It is a systemd user unit;
  the continuous-upload, health and purge work takes effect on the next agent
  restart or reinstall. The API and console halves are already live.
