# Tasks: screencast-recorder

This file is the concise human-readable work queue. Detailed task contracts
live under `docs/11_tasks/`; execution plans and validation reports remain
linked from those task documents.

Design: [`docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`](docs/superpowers/specs/2026-09-06-screencast-recorder-design.md).
Foundation plan: [`docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md`](docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md).

## Active

- [ ] `TASK-001-bootstrap-service` - complete documentation-first onboarding,
  integration decisions, implementation and validation.
- [ ] Register the Auth application `screencast-recorder` with the
  application-scoped default role `app:screencast-recorder:user`.
- [ ] Mint the service principal
  `svc-screencast-agent--screencast-recorder@internal.alfares.cz` with role
  `internal:screencast-recorder:agent`, using
  `auth-microservice/scripts/provision-service-token.js` only.
- [ ] Declare every Vault key in `k8s/external-secret.yaml` and verify by
  enumerating the resulting Kubernetes Secret, not by reading `Ready=True`.
- [ ] Create the Vault AppRole `screencast-agent` for the host-side agent.

## Ready next

- [ ] Pass the IPS planning gate
  (`validate_adoption_profile.py --root . --phase planning`).
- [ ] Register the ecosystem identity: GitHub remote, `ECOSYSTEM_MAP.md` row,
  and catalog entry with `ipsAdoptionRequired: true`.
- [ ] Write the API implementation plan, including the operator web UI.
- [ ] Write the host-agent implementation plan.

## Blocked

- [ ] `BUSINESS.md`, `docs/00_constitution/CONSTITUTION.md` and
  `docs/01_vision/VISION.md` require `status: approved` plus durable human
  approval evidence. The deploy preflight gate fails until the owner signs
  these off; an agent must not self-certify them.

## Completed

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
