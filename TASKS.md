# Tasks: screencast-recorder

This file is the concise human-readable work queue. Detailed task contracts
live under `docs/11_tasks/`; execution plans and validation reports remain
linked from those task documents.

Design: [`docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`](docs/superpowers/specs/2026-09-06-screencast-recorder-design.md).
Foundation plan: [`docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md`](docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md).

## Active

- [ ] Owner check of the preview screen in a browser. Everything server-side is
  validated (`docs/12_validation/VAL-TASK-002-session-preview.md`), but three
  behaviours only a real browser can confirm: that switching audio source
  mid-playback swaps the sound without the video reloading or restarting, that
  clicking the timeline seeks and the active audio follows, and that the two
  digital-silence sources play as silence rather than erroring.

  The Preview button shipped rendered but with no click handler bound, which
  no test caught because `public/app.js` had no coverage at all. Fixed in
  `9405bf3` and now guarded by `src/ui/console-wiring.spec.ts`, which asserts
  every generated button has a handler and every id the script addresses
  exists in the page.

## Ready next

- [ ] Phase 2 post-production: emit `session.stored`, then the BPCP-owned
  approval chain (edit -> preview -> owner approval -> YouTube -> owner
  approval for raw deletion).
- [ ] Webcam capture, once a camera is attached to a recording host.
- [ ] MacBook agent: a second registration and a capture-module swap, no API
  change. The command-acknowledgement gap that blocked a second machine is
  fixed; it still wants the live restart check named in Completed.
## Blocked

- None. The owner approved `BUSINESS.md`,
  `docs/00_constitution/CONSTITUTION.md` and `docs/01_vision/VISION.md` on
  2026-09-06; the IPS planning gate and the pre-coding gate both pass.

## Completed

- [x] **Command acknowledgement, implemented 2026-09-12. Not yet exercised on a
  live session.** `nextFor` used to set `deliveredAt` on handout and also read
  it as the done marker, so an agent that died between receiving a command and
  acting on it never saw that command again: a pending `stop` was dropped and
  its session sat in `stopping` for ever. Delivery is now a 30-second lease and
  a new `POST /api/agents/{id}/commands/{cid}/ack` is what retires a command;
  the agent acknowledges after applying, so a crash mid-handling keeps the
  command eligible. Redelivery is only safe because the agent's applied-set is
  now durable (`agent/src/applied-store.ts`): the restart that causes the
  redelivery is the event that used to empty the in-memory one, so without it a
  redelivered `start` would spawn a second ffmpeg tree into one directory.
  Bounded at 3 deliveries, after which the session is failed with
  `command_unacknowledged` rather than looping silently. 525 tests across 48
  suites, all passing; `commands.service.ts` had no spec at all before this and
  now has 12. Migration `1757200700000-CommandAcknowledgement` is additive and
  treats every pre-existing command as acknowledged — all 64 rows in the live
  database are already delivered, so nothing is stranded, and the alternative
  would redeliver the entire history on the agent's next poll. The old index
  name was read from the live database, not assumed.

  Outstanding: a live run confirming a stop survives `systemctl --user restart
  screencast-agent` mid-handling, which is the behaviour the change exists for
  and the one thing no test here proves. Evidence:
  [`docs/12_validation/VAL-TASK-004-command-acknowledgement.md`](docs/12_validation/VAL-TASK-004-command-acknowledgement.md).

- [x] **Continuous upload and capture-health alarms, 11 implementation commits
  delivered and validated 2026-09-11.** Deployed at `screencast.alfares.cz`
  (API/console), agent as systemd user unit. 503 tests across 46 suites, all
  passing. A live session uploads segments to S3 continuously during `recording`,
  so an agent restart loses up to 60 seconds instead of the entire session. Per-track
  health checks detect stalled and quiet microphones and alarm within ~15 seconds.
  Discard purges S3 objects scoped to that session while leaving local media intact.
  Save now takes seconds instead of three-minute-plus. Evidence:
  [`docs/12_validation/VAL-TASK-003-continuous-upload-and-alarms.md`](docs/12_validation/VAL-TASK-003-continuous-upload-and-alarms.md).
  The 11 commits: T1 segment eligibility, T2 bounded-concurrency upload, T3 live
  track directories, T4 S3 prefix fixed at start (API), T5 continuous upload
  queue, T6 stall/quiet detection, T7 durable pending reports, T8 agent wiring
  (all four modules), T9 API health + migration, T10 discard purges S3, T11
  console alarm banner. Three contracts amended to reflect the deployed reality:
  `SYSTEM.md` documents per-track upload state; `INTEGRATION_CONTRACT.md`
  specifies Discard as the only phase-1 retention operation; the 2026-09-06
  design spec supersedes the review-gate paragraph.

- [x] **Session preview, delivered and validated 2026-09-08.** Deployed at
  `screencast.alfares.cz` (image `e1c3540`), 293 tests across 34 suites.
  A three-source session rendered end to end: all three audio proxies plus a
  silent video proxy, levels separating the one microphone that carried signal
  (-51.2 dB) from two at the digital-silence floor; `moov` at byte 36 so the
  browser seeks over a presigned Range request without bucket CORS; the
  contention rule refusing to render while capture runs; and the ten original
  objects untouched. Evidence:
  [`docs/12_validation/VAL-TASK-002-session-preview.md`](docs/12_validation/VAL-TASK-002-session-preview.md).
  Browser playback — switching source mid-play without the video reloading,
  and timeline seeking — is the remaining owner check.

- [x] Three defects found by that validation and fixed: the pod crash-looped
  because `PreviewModule` did not provide the `Logger` that `AgentRoleGuard`
  takes (the readiness probe kept the old pod serving, so the deploy read as
  successful); `migrationsRun` was never set, so no migration had ever run at
  deploy and `selectedSourceRef` was missing from the live database; and this
  repository had no `post-commit` hook, so none of its commits ever reached the
  deploy queue.

- [x] **Fixed: keystroke and click density is captured and now visible.** In
  two parts, and the gap between them is the lesson. An XInput2 listener
  (`agent/src/activity/input-listener.ts`) feeds the existing counters:
  verified on the live desktop rather than in isolation, five synthetic `a`
  presses plus `ctrl+s` plus two clicks produced
  `keys=7 clicks=2 hotkeys=["ctrl+key"]`. The keycode is discarded at parse
  time and replaced by an opaque placeholder, so a combination is visible as
  `ctrl+key` while the character is never recorded.

  That fix was recorded as complete while no operator could see a keystroke.
  `buildTimeline` still dropped both counters at bucket construction, so the
  console drew mouse movement alone and the preview screen carried a hardcoded
  note saying density was not captured — months after it was. The counters now
  reach the browser and are drawn as their own band under the mouse trace.
  Sessions recorded before the listener existed report `inputMeasured: false`
  and say so in words, rather than drawing zeroes that would read as a quiet
  session. A component verified in isolation is not a delivered feature; this
  one was checked end to end, on the screen, against both an old session and a
  new one.

- [x] Phase 1 delivered and validated end to end on 2026-09-07. Deployed at
  `screencast.alfares.cz` (image `7f23ec3`), agent running as a systemd user
  service. A live session recorded 4K screen + Jabra audio + activity metadata,
  survived a 45-second controller outage with no lost footage, stopped
  gracefully, and reached `stored` only after independent object readback; a
  discarded session uploaded nothing. 144 tests across 19 suites. Evidence:
  `docs/12_validation/VAL-TASK-001-bootstrap-service.md`.
- [x] Five defects found by that run and fixed with regression tests: display
  offsets rejected by the API; the agent reading tracks from `start` instead of
  `prepare`; no handler completing a stop; no handler for `upload`; and a
  storage layout missing the hostname segment.

- [x] API service, plan tasks 1-8: bootable skeleton on 3391; entities and
  migrations; the agent guard; the registry; the session lifecycle with an
  all-agents-ready start barrier; MinIO readback verification; manifest
  ingestion; and the operator web UI. 43 tests across 8 suites.
- [x] Verified against live systems rather than mocks: no-token 401, bogus
  token 403 and the real pair token accepted through auth-microservice;
  enrolment idempotent on re-enrolment; the scoped MinIO credential denied on
  `speakasap-records` with AccessDenied; the console rendering this host's real
  HDMI-A-0 and Jabra with the webcam shown unavailable; and the built container
  serving all of it.
- [x] Three defects found by that verification and fixed: /auth/validate takes
  the token in the body and a 200 with valid:false is a rejection;
  @PrimaryGeneratedColumn('uuid') inserts NULL without a database default; and
  s3Prefix must be fixed at Save, or a session spanning midnight is verified
  against a prefix nothing was uploaded to.
- [x] Repository harness scaffolded: port 3391, domain
  `screencast.alfares.cz`, namespace `statex-apps`.
- [x] PostgreSQL database `screencast` created. Role `screencast_app` is
  non-superuser with no createrole or createdb, owns every object in the
  database, and `CONNECT` is revoked from `PUBLIC`.
- [x] MinIO bucket `screencast-sessions`, policy `screencast-rw`, non-root user
  `screencast-recorder`, and a runtime service account. Verified able to read
  and write its own bucket and denied on `speakasap-records`, on every other
  bucket, and on all admin operations.
- [x] Vault path `secret/prod/screencast-recorder` created with database,
  MinIO and service-URL keys. No value was printed at any point.
- [x] Documentation set adopted from a parallel working copy and reconciled
  against verified live infrastructure.

## Handoff

Current machine-readable state: [`STATE.json`](STATE.json).
Detailed bootstrap task:
[`docs/11_tasks/TASK-001-bootstrap-service.md`](docs/11_tasks/TASK-001-bootstrap-service.md).

## Phase 2 backlog

Out of scope for phase 1, listed so the manifest and event schema stay designed
for them: AI-assisted editing, preview rendering, human approval, YouTube
publication, and the explicit raw-footage retention and deletion workflow.

## Known ecosystem findings

- Thirteen databases retain the default `PUBLIC` CONNECT grant
  (`auth`, `backups`, `bpcp`, `cv`, `growth_core`, `marathon`, `minio`,
  `monitoring`, `orders`, `payment`, `postgres`, `scratch_alert_mig`,
  `warehouse_db`), so any login role can open a connection to them. Table
  grants still apply, so the exposure is catalog metadata and a connection
  slot rather than row data. Pre-existing and out of scope here; it belongs to
  the approved DB per-app-roles migration.
- `shared/scripts/scaffold-new-service.py` emits a `STATE.json` using legacy
  narrative keys that the shared pre-commit hook rejects, so every newly
  scaffolded repository fails its first commit until the file is rewritten to
  the wave-projection contract.
