# Tasks: screencast-recorder

This file is the concise human-readable work queue. Detailed task contracts
live under `docs/11_tasks/`; execution plans and validation reports remain
linked from those task documents.

Design: [`docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`](docs/superpowers/specs/2026-09-06-screencast-recorder-design.md).
Foundation plan: [`docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md`](docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md).

## Active

- [ ] **Defect: the activity tracker never counts keystrokes or clicks.**
  `ActivityTracker.countKey()` and `countClick()` have no caller anywhere in
  `agent/src` — no input listener is wired to them — so every stored session
  reports zeroes. Evidence: zero callers outside their own definitions; the
  reference session `d5b209c3` carries 439 samples with `keys=0, clicks=0,
  hotkeys=0` throughout, alongside 52 mouse movements and 6 distinct windows.
  **Keypress and click density is unavailable for all existing recordings.**
  The counters were unit-tested in isolation and reported as working on the
  strength of the event shape rather than the signal, so a zero read as a quiet
  second instead of an absent feature. Session preview therefore renders keys
  and clicks as "not captured" and never as a zero value, a flat line or an
  empty bar (see
  [`docs/superpowers/specs/2026-09-07-session-preview-design.md`](docs/superpowers/specs/2026-09-07-session-preview-design.md)).
  Fixing the input listener is separate work and deliberately not part of
  preview: the agent holds the only copy of an unrepeatable recording.

## Ready next

- [ ] Session preview: play back the screen, audio and activity timeline of a
  stored session. Design:
  [`docs/superpowers/specs/2026-09-07-session-preview-design.md`](docs/superpowers/specs/2026-09-07-session-preview-design.md);
  original prompt: `docs/superpowers/specs/2026-09-07-preview-prompt.md`.
  Preview exists so the operator can see what was recorded; it is not a gate on
  retention and authorises no deletion.
- [ ] Phase 2 post-production: emit `session.stored`, then the BPCP-owned
  approval chain (edit -> preview -> owner approval -> YouTube -> owner
  approval for raw deletion).
- [ ] Webcam capture, once a camera is attached to a recording host.
- [ ] MacBook agent: a second registration and a capture-module swap, no API
  change.
- [ ] Command acknowledgement. `nextFor` marks a command delivered on handout,
  so an agent that dies between receiving and acting never sees it again.
  Acceptable for one operator who can re-issue from the console; it needs
  fixing before a second machine joins.

## Blocked

- None. The owner approved `BUSINESS.md`,
  `docs/00_constitution/CONSTITUTION.md` and `docs/01_vision/VISION.md` on
  2026-09-06; the IPS planning gate and the pre-coding gate both pass.

## Completed

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
