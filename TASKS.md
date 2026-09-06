# Tasks: screencast-recorder

This file is the concise human-readable work queue. Detailed task contracts
live under `docs/11_tasks/`; execution plans and validation reports remain
linked from those task documents.

Design: [`docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`](docs/superpowers/specs/2026-09-06-screencast-recorder-design.md).
Foundation plan: [`docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md`](docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md).

## Active

- [ ] `TASK-001-bootstrap-service` - complete documentation-first onboarding,
  integration decisions, implementation and validation.
- [ ] Host agent, per
  [`plans/2026-09-06-screencast-recorder-agent.md`](docs/superpowers/plans/2026-09-06-screencast-recorder-agent.md):
  capability discovery, Vault AppRole loading, the chrony barrier, VAAPI
  capture with segmentation, the activity tracker, the manifest writer, the
  resumable uploader, the command loop, and the systemd user unit.

## Ready next

- [ ] Deploy the API (plan task 9). Requires removing the temporary
  `screencast-recorder` entry from `shared/scripts/deploy-queue/registry.sh`,
  which exists only while the repo has no application code. Deliberately
  deferred: the API has nothing to talk to until the agent exists, so
  deploying now would place an idle service in the cluster.
- [ ] End-to-end validation once both halves exist, including killing the API
  mid-recording to prove capture survives a controller outage.
- [ ] Complete `docs/12_validation/VAL-TASK-001-bootstrap-service.md` with the
  recorded evidence, which is what closes TASK-001.

## Blocked

- None. The owner approved `BUSINESS.md`,
  `docs/00_constitution/CONSTITUTION.md` and `docs/01_vision/VISION.md` on
  2026-09-06; the IPS planning gate and the pre-coding gate both pass.

## Completed

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
