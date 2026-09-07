# TASK-001-bootstrap-service: Bootstrap screencast-recorder

```yaml
id: TASK-001-bootstrap-service
status: completed
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-06
last_updated: 2026-09-06
completeness_level: complete
upstream:
  - ../../BUSINESS.md
  - ../../SYSTEM.md
  - ../01_vision/VISION.md
goal_impact:
  - ../22_goal_impact/GOAL-IMPACT-TASK-001.md
execution_plan:
  - ../21_execution_plans/EP-TASK-001-bootstrap-service.md
project_invariant_impact: preserves
sensitive_data_classification: none
contract_schema_impact: creates
replay_determinism_impact: affected
parallel_workstream_context: final-integration
required_gates:
  - adoption
  - pre-coding
```

## Objective

Deliver an ecosystem-integrated capture service: a Kubernetes API and operator
web UI on port 3391, plus a host-bound recording agent, that together record a
multi-hour development session as independent, time-aligned tracks and store an
accepted session in the dedicated `screencast-sessions` MinIO bucket with
verification.

## Upstream links

- [`BUSINESS.md`](../../BUSINESS.md) — the problem, the value proposition, and
  the phase-1 non-goals; the business metric is editing time saved per
  published video, not footage recorded.
- [`SYSTEM.md`](../../SYSTEM.md) — responsibilities, state machine, data model,
  timing contract, and the verified infrastructure and host capture
  environment.
- [`docs/01_vision/VISION.md`](../01_vision/VISION.md) — the phase-1 outcome
  and the architecture boundary between the Kubernetes control plane and the
  host-bound capture agent.
- [`docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`](../superpowers/specs/2026-09-06-screencast-recorder-design.md)
  — the full technical design and the rejected alternatives.

## Goal impact

See [`GOAL-IMPACT-TASK-001.md`](../22_goal_impact/GOAL-IMPACT-TASK-001.md).
Bootstrapping this service is what converts unrecorded work into structured,
machine-editable source material; without it, no later post-production goal can
begin, because the raw footage would lack the timing data an editor needs.

## Project invariant impact

Preserves. The invariants this task must not violate:

- no raw keystroke or clipboard content is ever captured or stored;
- MinIO root credentials are never used at runtime;
- no secret value enters Git, documentation, logs or terminal output;
- local session media is never deleted before it is uploaded, verified in S3,
  and previewed by the operator;
- `/srv/speakasap-records/speakasap-records/` is never touched;
- service-to-service authentication follows the canonical service identity
  standard without exception.

Evidence: the scoped storage credential is verified denied on every other
bucket and on all admin operations; the activity tracker records counts and
modifier names only.

## Sensitive-data classification

Classified `none` for stored *content* in the sense of regulated personal data,
but the task handles two sensitive classes that must not leak:

1. **Credentials** — database, MinIO and Auth material. Handled only through
   Vault; key names may be documented, values never.
2. **Incidental on-screen content** — a screen recording can capture whatever
   is displayed, including secrets in a terminal. This is why keystroke content
   is never recorded, why the bucket is private with no anonymous read, and why
   upload requires an explicit operator Save.

Test evidence uses synthetic short recordings, never a real working session.

## Contract and schema impact

Creates:

- PostgreSQL schema: `agents`, `sessions`, `tracks` in database `screencast`.
- HTTP API on port 3391: session lifecycle, agent registration and capability
  reporting, the agent long-poll command channel, and `GET /health`.
- Object layout `sessions/<YYYY>/<MM>/<DD>/<session-id>/` with `manifest.json`
  as the timing contract for phase-2 editing.
- Published event `session.stored`.

No existing ecosystem contract is modified.

## Replay and determinism impact

Affected, and handled explicitly:

- Segment upload is idempotent per object key; a resumed upload skips objects
  already verified present.
- `session.stored` is at-least-once, so consumers must be idempotent on session
  id.
- Agent commands are idempotent per `(session_id, command)`; a redelivered
  `start` after `T0` has passed must not spawn a second capture.
- Capture itself is inherently non-deterministic — the same session cannot be
  reproduced — which is exactly why local media is never deleted before
  verification and operator preview.

## Scope

- Repository harness, IPS document set, integration contract.
- Provisioning: database and least-privilege role, MinIO bucket with a scoped
  non-root credential, Vault path and ExternalSecret wiring, Auth application
  and service principal, and the agent's Vault AppRole.
- API service with the operator web UI: new session, recording, review,
  sessions.
- Host agent: capability discovery, clock barrier, ffmpeg supervision,
  segmentation, activity metadata, upload with verification.
- Deployment configuration, health endpoint, monitoring and structured logging.
- Ecosystem catalog and map registration.

## Non-goals

- Webcam capture (no camera is attached to the host).
- The MacBook agent.
- AI editing, preview rendering, YouTube publication, and automatic deletion of
  raw footage — all phase 2.
- Any orchestration of live capture through runlayer or BPCP; capture is a
  local state machine so that it survives a controller outage.

## Acceptance criteria

- [ ] The IPS planning gate and the pre-coding gate both pass.
- [ ] A real recording session on `alfares` captures the 3840x2160 `HDMI-A-0`
      display and the Jabra microphone as separate segmented tracks, with
      `events.jsonl` and `manifest.json` written at stop.
- [ ] Start is refused unless the clock barrier and disk-space check pass, and
      the audible start and stop beeps are emitted.
- [ ] Killing the API mid-recording does not stop or corrupt the capture; state
      reconciles when it returns.
- [ ] Save uploads every object, verifies each is present in S3, and marks the
      session stored; Discard deletes local files and uploads nothing.
- [ ] The scoped MinIO credential is verified denied on `speakasap-records` and
      on all admin operations.
- [ ] `GET /health` serves Kubernetes probes, logs reach
      `logging-microservice`, and the service is registered in the ecosystem
      catalog and map.
- [ ] No secret value appears in Git, logs or terminal output, and no keystroke
      content appears in any captured metadata.

## Required context

- `../../BUSINESS.md`
- `../../SYSTEM.md`
- `../06_architecture/INTEGRATION_CONTRACT.md`
- `../17_governance/PROJECT_INVARIANTS.md`
- `../21_execution_plans/EP-TASK-001-bootstrap-service.md`
- `../superpowers/specs/2026-09-06-screencast-recorder-design.md`
- `../superpowers/plans/2026-09-06-screencast-recorder-foundation.md`
- `/home/ssf/Documents/Github/shared/docs/CREATE_SERVICE.md`
- `/home/ssf/Documents/Github/auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md`
- `/home/ssf/Documents/Github/intent-preservation-system/docs/24_onboarding/PROJECT_ADOPTION_STANDARD.md`

## Validation task

Validation report:
`../12_validation/VAL-TASK-001-bootstrap-service.md`.

## Required gates

| Gate | Command or evidence | Blocks on |
| --- | --- | --- |
| Adoption | `python3 ../intent-preservation-system/scripts/validate_adoption_profile.py --root . --phase planning` | Missing/incomplete project documents or integration decisions |
| Pre-coding | `python3 ../intent-preservation-system/scripts/pre_coding_gate.py --root .` | Traceability, invariants, scope or sensitive-data violations |
| Application | `npm run typecheck && npm run test && npm run build` | Implementation regression |
| Integration | Scoped-credential denial check, ExternalSecret key enumeration, authenticated agent call against a role-decorated route, and a real capture-to-stored session | Broken required integration |

## Parallel workstream context

- **Ready now:** the API service and its web UI; the host agent's capability
  discovery and ffmpeg supervision. These share only the HTTP contract, so they
  can proceed in parallel once that contract is fixed.
- **Dependency-gated:** upload and verification depend on the scoped MinIO
  credential (done); the agent's authenticated calls depend on the service
  principal and AppRole (pending).
- **Blocked:** deployment, which depends on owner approval of `BUSINESS.md`,
  the constitution and the vision, and on a genuinely validated bootstrap
  validation report.
- **Final integration:** the end-to-end recording session that exercises the
  barrier, capture, stop, review, save and verification together.
