# Tasks: screencast-recorder

This file is the concise human-readable work queue. Detailed task contracts
live under `docs/11_tasks/`; execution plans and validation reports remain
linked from those task documents.

Design: [`docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`](docs/superpowers/specs/2026-09-06-screencast-recorder-design.md).
Foundation plan: [`docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md`](docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md).

## Active

- [ ] **Session preview: tasks 1-10 implemented, awaiting live verification.**
  Plan: [`docs/superpowers/plans/2026-09-07-session-preview.md`](docs/superpowers/plans/2026-09-07-session-preview.md).
  All code is committed and pushed: activity timeline, audio selection, the
  `session_previews` entity and both migrations, presigned media URLs,
  `PreviewService`, `PreviewController`, `PreviewAgentController`, the agent
  renderer and its contention refusal, the `preview-complete` callback and
  the console screen. 288 tests across 32 suites, green.

  Verified against the real system so far:
  - The ffmpeg arguments render a real 15.2-minute stored session: 65 MB of
    4K source to a 4.4 MB proxy in 39.8s, probed at 960x540/10fps, `moov` at
    byte 36 so faststart genuinely works, and audio/video durations agreeing
    to within 1s.
  - MinIO answers a presigned Range request with `206 Partial Content`,
    `content-range: bytes 0-102399/3341393`, exactly 102400 bytes. Seeking
    needs no CORS and no chunking, and the bucket was not modified.
  - The API's and the agent's key slugging agree on all three real PipeWire
    source refs of this host, and give each a distinct key.

  Still to do (task 11): preview a session through the deployed console,
  confirm all three audio sources play and that switching source does not
  reload the video, verify the contention rule live by requesting a render
  during a recording, and confirm nothing was deleted.

  **Blocked on the deploy queue**: the pod still runs image `2415b96` while
  HEAD is `f402ce6`. The queue is shared and had five services ahead. The
  agent also needs restarting to pick up `render-preview` -- until both are
  current, nothing above can be exercised end to end.

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

- [x] **Fixed: the activity tracker now counts keystrokes and clicks.** An
  XInput2 listener (`agent/src/activity/input-listener.ts`) feeds the existing
  counters. Verified on the live desktop rather than in isolation, which is how
  the original defect escaped: five synthetic `a` presses plus `ctrl+s` plus two
  clicks produced `keys=7 clicks=2 hotkeys=["ctrl+key"]`. The keycode is
  discarded at parse time and replaced by an opaque placeholder, so a
  combination is visible as `ctrl+key` while the character is never recorded.

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
