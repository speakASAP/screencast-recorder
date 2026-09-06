# EP-TASK-001-bootstrap-service: Bootstrap screencast-recorder

```yaml
id: EP-TASK-001-bootstrap-service
status: approved
source_task: ../11_tasks/TASK-001-bootstrap-service.md
goal_impact:
  - ../22_goal_impact/GOAL-IMPACT-TASK-001.md
validation:
  - ../12_validation/VAL-TASK-001-bootstrap-service.md
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-06
last_updated: 2026-09-06
completeness_level: complete
parallelization_strategy: parallel_goals
required_gates:
  - adoption
  - pre-coding
```

## Upstream traceability

- Business: [`BUSINESS.md`](../../BUSINESS.md) *Problem*, *Goals*, *Success
  metrics*, *Business constraints*
- Vision: [`docs/01_vision/VISION.md`](../01_vision/VISION.md) *Phase 1
  outcome*, *Architecture boundary*, *Activity metadata boundary*
- System: [`SYSTEM.md`](../../SYSTEM.md) *Core state machine*, *Data model*,
  *Timing contract*, *MinIO contract*, *Provisioned infrastructure*
- Task: [`TASK-001-bootstrap-service.md`](../11_tasks/TASK-001-bootstrap-service.md)
- Goal impact: [`GOAL-IMPACT-TASK-001.md`](../22_goal_impact/GOAL-IMPACT-TASK-001.md)
- Design: [`2026-09-06-screencast-recorder-design.md`](../superpowers/specs/2026-09-06-screencast-recorder-design.md)
- Foundation plan: [`2026-09-06-screencast-recorder-foundation.md`](../superpowers/plans/2026-09-06-screencast-recorder-foundation.md)

## Scope

The Kubernetes API service with its operator web UI, the host-bound recording
agent, and the provisioning and deployment configuration that connect them to
Auth, Vault, PostgreSQL, MinIO, logging and monitoring.

## Non-goals

Webcam capture, the MacBook agent, AI editing, preview rendering, YouTube
publication, automatic deletion of raw footage, and any orchestration of live
capture through runlayer or BPCP.

## Project invariants

| Invariant | Preservation method |
|---|---|
| No keystroke or clipboard content | The tracker has no code path that reads key symbols; it records counts and modifier names. Verified by inspecting `events.jsonl`. |
| No MinIO root at runtime | Runtime uses a scoped service account; root is used once at provisioning. Verified by a denial test. |
| No secret in Git, logs or output | Vault only; key names documented, values never. Enforced by the pre-commit hook and by review. |
| No premature deletion | Deletion requires S3 verification and operator preview; phase 1 deletes nothing automatically. |
| `speakasap-records` untouched | Storage policy boundary, verified by denial. |
| Canonical service identity | One Auth-signed RS256 principal per pair, minted only by `provision-service-token.js`. |

## Sensitive-data handling

Configuration carries key names only. Test fixtures use synthetic short
recordings, never a real working session, because a screen recording can
incidentally capture on-screen secrets. Logs never include credentials, S3
presigned URLs, or window titles that might contain sensitive paths. Evidence
attached to the validation report is limited to counts, sizes, object keys and
denial results.

## Contract validation plan

- **API:** contract tests for session lifecycle transitions, agent registration
  and capability reporting, and the long-poll command channel.
- **Persistence:** migration applies cleanly to the empty `screencast`
  database; `agents`, `sessions` and `tracks` round-trip.
- **Storage:** upload, readback verification, and a denial test against
  `speakasap-records` and admin operations.
- **Event:** `session.stored` is published once per stored session and is
  idempotent on session id.
- **Identity:** an authenticated agent call succeeds against a role-decorated
  route; a call without the pair token is denied and error-logged.
- **Secrets:** the generated Kubernetes Secret is verified by enumerating its
  keys, never by reading `Ready=True`.

## Replay and determinism plan

Segment upload is idempotent per object key, and a resumed upload skips
verified objects. Agent commands are idempotent per `(session_id, command)`: a
redelivered `start` after `T0` must not spawn a second capture. `session.stored`
is at-least-once. Capture itself is not reproducible, so tests assert on
structural properties — segment continuity, manifest completeness, monotonic
timestamps — rather than byte equality.

## Files to inspect

- `SYSTEM.md`, `BUSINESS.md`, `docs/06_architecture/INTEGRATION_CONTRACT.md`
- `docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`
- `k8s/*.yaml`, `deploy.config.sh`, `.env.example`
- `/home/ssf/Documents/Github/auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md`
- `/home/ssf/Documents/Github/cv-tuning` as a current NestJS + TypeORM reference

## Files to create

- `api/` — NestJS application: session, agent, track, storage and health
  modules; TypeORM entities and migrations; the operator web UI.
- `agent/` — Node host process: capability discovery, clock barrier, ffmpeg
  supervision, activity tracker, uploader.
- `agent/systemd/screencast-agent.service` — systemd **user** unit.
- `scripts/install-agent.sh` — agent installation.
- Tests alongside each module.

## Files to modify

- `k8s/deployment.yaml`, `k8s/service.yaml`, `k8s/ingress.yaml`,
  `k8s/configmap.yaml`, `k8s/external-secret.yaml`
- `TASKS.md`, `STATE.json`, `docs/12_validation/VAL-TASK-001-bootstrap-service.md`

## Files that must not be modified

- `docs/00_constitution/CONSTITUTION.md`
- `docs/01_vision/VISION.md`
- `BUSINESS.md`
- Anything under `/srv/speakasap-records/`
- Any other repository's Vault path, database or bucket

## Implementation steps

1. Complete the remaining provisioning: Auth application and default user role,
   the service principal, ExternalSecret entries for every Vault key, and the
   agent AppRole.
2. Pass the adoption and pre-coding gates.
3. Define the API/agent HTTP contract and fix it, so the two workstreams can
   proceed in parallel.
4. Build the API: entities and migration, session state machine, agent registry
   and long-poll channel, `GET /health`, logging integration.
5. Build the operator web UI: new session, recording, review, sessions.
6. Build the agent: capability discovery, clock barrier, ffmpeg supervision with
   VAAPI and segmentation, activity tracker, graceful stop, manifest writer.
7. Build the uploader: per-segment upload, readback verification, and the
   deletion rule that requires verification plus operator preview.
8. Wire deployment: manifests, probes, monitoring, and the agent's systemd user
   unit.
9. Run the end-to-end recording, complete the validation report, and only then
   remove the temporary deny-list entry in
   `shared/scripts/deploy-queue/registry.sh`.

## Parallel execution

| Workstream | Status | Owner role | Allowed files | Dependencies | Validation | Merge order |
| --- | --- | --- | --- | --- | --- | --- |
| Documentation and contracts | complete | Implementing agent | `*.md`, `docs/**`, `ips-adoption.json` | none | Adoption gate | first |
| API and web UI | ready now | Implementing agent | `api/**`, `k8s/**` | Fixed HTTP contract | Unit + contract tests, `/health` | second |
| Host agent | ready now | Implementing agent | `agent/**`, `scripts/install-agent.sh` | Fixed HTTP contract | Capture smoke test on `alfares` | second |
| Deployment and integration | final integration | Integration owner | `k8s/**`, `deploy.config.sh` | Validated application, owner approval of protected intent | End-to-end session, denial tests, Secret key enumeration | last |

## Blockers

- Owner approval of `BUSINESS.md`, `docs/00_constitution/CONSTITUTION.md` and
  `docs/01_vision/VISION.md`. The adoption gate and the deploy preflight both
  fail until these carry `status: approved` with durable approval evidence, and
  an agent must not self-certify them.
- Webcam validation is deferred until a camera is attached to the host.

## Test plan

- **Unit:** session state transitions including illegal ones; manifest
  generation; activity-event serialisation; segment-name ordering.
- **Contract:** API request and response shapes; agent command idempotency;
  `session.stored` payload.
- **Integration:** migration against a scratch database; upload and readback
  against `screencast-sessions`; authenticated agent call.
- **Failure mode:** API killed mid-recording; disk floor reached; one ffmpeg
  process killed while others continue; upload interrupted and resumed;
  `SIGINT` versus `SIGKILL` at stop, confirming the MP4 finalises.
- **Security:** denial on `speakasap-records`, denial of admin operations,
  `events.jsonl` contains no key characters, no secret in logs.

## Validation plan

| Acceptance criterion | Command or evidence |
| --- | --- |
| Gates pass | `validate_adoption_profile.py --phase planning`; `pre_coding_gate.py` |
| Real capture | A session on `alfares` producing segmented `HDMI-A-0` and Jabra tracks plus `events.jsonl` and `manifest.json` |
| Barrier enforced | Start refused with clock unsynchronised or disk below floor; beeps observed |
| Outage resilience | API killed mid-session; capture continues; state reconciles |
| Save and Discard | Every object verified present in S3 before `stored`; Discard uploads nothing |
| Storage scope | Denial test output for `speakasap-records` and admin operations |
| Observability | `GET /health` serving probes; log entries visible in logging-microservice |
| Privacy | Inspection of `events.jsonl` showing counts and modifiers only |

## Gate commands

Run from the adopting repository:

```bash
python3 ../intent-preservation-system/scripts/validate_adoption_profile.py --root . --phase planning
python3 ../intent-preservation-system/scripts/pre_coding_gate.py --root .
```

The central deployment-readiness gate is intended for repositories adopting
the complete IPS tree. Lightweight service adoption uses the adoption gate,
project tests, integration evidence and the shared deployment preflight.

## Documentation updates

`TASKS.md` and `STATE.json` at each checkpoint;
`docs/12_validation/VAL-TASK-001-bootstrap-service.md` on completion;
`SYSTEM.md` if the verified infrastructure changes;
`docs/orchestrator/VALIDATION_DEBT.md` for any deferred verification;
`shared/ECOSYSTEM_MAP.md` and the repository catalog at registration.

## Rollback plan

- **Code:** revert the commit; the deploy queue redeploys the previous image.
- **Migration:** the initial migration creates tables in an empty database, so
  rollback is dropping them; no other service reads this schema.
- **Manifests:** `kubectl rollout undo deployment/screencast-recorder -n statex-apps`.
- **Agent:** `systemctl --user stop screencast-agent`; local session media is
  untouched by a rollback and must not be deleted as part of one.
- **Integration:** the MinIO bucket, policy, user and Vault path are additive
  and are left in place; removing them is a separate, deliberate action.

## Handoff

Each workstream reports files changed, the commands run with their output,
validation evidence, validation debt, deviations from this plan, and the next
concrete action. Sub-agents stop before deployment. Final integration is the
owner's, and begins only after protected intent is approved.

## Completion checklist

- [ ] Protected intent approved
- [ ] Adoption profile valid
- [ ] Integration decisions complete
- [ ] Implementation and tests complete
- [ ] Required integrations exercised
- [ ] Deployment dry run passes
- [ ] Validation report complete
