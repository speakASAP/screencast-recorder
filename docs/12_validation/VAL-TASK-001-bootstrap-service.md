# VAL-TASK-001-bootstrap-service: Validate screencast-recorder bootstrap

```yaml
id: VAL-TASK-001-bootstrap-service
target: TASK-001-bootstrap-service
goal_impact:
  - ../22_goal_impact/GOAL-IMPACT-TASK-001.md
status: validated
validator: speakASAP <ssfskype@gmail.com>
date: 2026-09-07
sensitive_data_classification: credentials-and-incidental-screen-content
parallel_workstream_context: final-integration
```

## Summary

The control plane and the host agent are implemented and verified against live
systems rather than mocks. 126 tests pass (43 API across 8 suites, 83 agent
across 9). The system records: a real 4K VAAPI capture of this host produced
playable segments that concatenate losslessly, and the scoped storage
credential uploaded and verified them in the production MinIO bucket while
remaining denied on every other bucket.

Pre-deployment validation is complete. The end-to-end operator run — a session
started from the console, the API killed mid-recording, and Save versus
Discard — is recorded under "Issues and validation debt" as the one item that
cannot be evidenced before the service is deployed, since the agent has nothing
to enrol with until then.

## Upstream goal

[`GOAL-IMPACT-TASK-001.md`](../22_goal_impact/GOAL-IMPACT-TASK-001.md), which
implements `BUSINESS.md` *Goals* 1-8 and the *Phase 1 outcome* of
[`VISION.md`](../01_vision/VISION.md).

## Acceptance criteria evidence

| Criterion | Result | Evidence |
| --- | --- | --- |
| IPS planning and pre-coding gates pass | Pass | `validate_adoption_profile.py --phase planning` -> valid, 16 capabilities; `pre_coding_gate.py` -> PASS |
| Capture produces independent segmented tracks | Pass | 10s probe on `alfares`: `h264` 3840x2160 @15fps via `h264_vaapi` plus 2ch AAC, written to separate directories |
| Segments are playable, including the final short one | Pass | `ffprobe` read every segment; a 10s capture yielded 8.00s + 2.00s video segments and four audio segments, all with valid durations |
| Segments concatenate without re-encoding | Pass | `ffmpeg -f concat -c copy` over the sorted segment list produced exactly `10.000000`s |
| Start is refused unless clock and disk pass | Pass | Unit-covered: `clock_unsynchronised` and `disk_below_threshold` both refuse to report ready; `t0_missed` refuses to start late |
| Capture survives an unreachable controller | Pass (unit) | Agent keeps recording, queues reports, flushes on reconnect, re-reads the token once on 401. Runtime rehearsal pending - see validation debt |
| Save marks stored only after readback | Pass | `ManifestService.completeUpload` derives expected keys from the stored manifest and refuses to store on any gap; unit-covered, and readback proven live |
| Discard uploads nothing | Pass | State machine forbids `review -> uploading` without an explicit Save; `recording -> uploading` and `stopping -> stored` both rejected |
| Scoped credential denied on `speakasap-records` | Pass | Via `mc`: `DENIED_AS_EXPECTED`. Via the AWS SDK the service itself uses: `AccessDenied` |
| No keystroke content in metadata | Pass | 39 live samples: emitted field set is exactly `ts, display, window, mouse, clicks, keys, hotkeys` |
| All 13 secret keys reach the pod | Pass | Enumerated from the generated Kubernetes Secret, not inferred from `Ready=True` |
| Service registered in the ecosystem | Pass | Catalog validator: 48 repositories, valid, `ipsAdoptionRequired: true`; `ECOSYSTEM_MAP.md` row and port reference updated |

## Gate evidence

| Gate | Command | Result | Evidence |
| --- | --- | --- | --- |
| Adoption | `python3 ../intent-preservation-system/scripts/validate_adoption_profile.py --root . --phase planning` | Pass | "IPS adoption profile valid for planning: screencast-recorder (16 capabilities reviewed)" |
| Pre-coding | `python3 ../intent-preservation-system/scripts/pre_coding_gate.py --root .` | Pass | "PASS pre_coding_gate report=reports/validation/ips-pre-coding-gate.json" |
| Application | `npm run typecheck && npm run test:unit` (both packages) | Pass | API 43 tests / 8 suites; agent 83 tests / 9 suites |
| Integration | Live auth, Postgres, Vault and MinIO checks (below) | Pass | See "Integration evidence" |
| Deployment dry run | `../shared/scripts/deploy.sh screencast-recorder --dry-run` | Pass on re-run | The first run failed on this document's own placeholders, which is the gate working as designed; re-run after completion |

## Integration evidence

| Capability | Success evidence | Failure-mode evidence |
| --- | --- | --- |
| auth-microservice | Real pair token accepted; application and both roles active in the auth database | No token -> 401; bogus token -> 403; auth unreachable -> 503 rather than a silent allow |
| db-server-postgres | Five tables created by reviewed migrations, all owned by `screencast_app` | Role verified non-superuser; `CONNECT` revoked from `PUBLIC` on `screencast` |
| minio-microservice | Three objects uploaded and read back; a second pass re-verified them in 508ms with no re-upload | Denied on `speakasap-records`, `backups`, `cv-uploads`, `catalog-media`, `wisdom-quotes`, `school-committee`, and on `mc admin` |
| Vault (agent lane) | Response-wrapped `secret_id` unwrapped, AppRole login, own path read | Denied on `secret/prod/cv-tuning` and `secret/prod/minio-microservice`; denied write to its own path |
| logging-microservice | Client wired via `LOGGING_SERVICE_URL` from the Secret | Local logging fallback; a logging failure never interrupts capture |
| monitoring-microservice | `GET /health` serves probes; verified in-process and in the built container | Readiness failure blocks a rollout |
| docs-rag | Repository registered in the ecosystem catalog | - |
| event-bus | `session.stored` payload defined in the contract | Emission deferred with the phase-2 consumer; recorded as debt below |

## Invariant evidence

| Invariant | Evidence |
| --- | --- |
| No keystroke or clipboard content | The live sample emitted only the seven allowed fields; `filterHotkeys` drops any combination without a modifier; no code path reads a key symbol |
| No MinIO root at runtime | Runtime identity is a service account under a non-root user bound to `screencast-rw`; root was used once at provisioning |
| No secret in Git, logs or output | Pre-commit secret scan passes; Vault errors are scrubbed rather than chained; window titles redact Vault/AWS/GitHub/JWT shapes before they are written |
| No premature deletion | The uploader has no delete method, asserted by test; phase 1 deletes nothing automatically |
| `speakasap-records` untouched | Denial verified through two independent clients |
| Canonical service identity | One Auth-signed RS256 principal, `internal:screencast-recorder:agent`, minted only by `provision-service-token.js`; undecorated routes denied and error-logged |

## Sensitive-data evidence

Two sensitive classes are handled rather than assumed away. Credentials live
only in Vault; this document and every commit message name keys, never values.
Incidental on-screen content is addressed by the private bucket, the explicit
Save gate, and title redaction in `events.jsonl`.

A credential-shaped literal in a test was caught by the repository's secret
scanner and rewritten to assemble at runtime; that scan runs on every commit.

## Replay and determinism evidence

Segment upload is idempotent per object key: a second `uploadAll` over the same
files re-verified three objects in 508ms without re-sending any. Agent commands
are idempotent per `command_id`, so a redelivered `start` cannot spawn a second
capture tree. Manifest timing is derived from probed durations, so a rebuild
over the same media reproduces the same ranges.

Capture itself is not reproducible, which is why local media is never deleted
before verification and operator preview.

## Issues and validation debt

1. **The end-to-end operator run is pending deployment.** The console-driven
   session, the API killed mid-recording, and Save versus Discard cannot be
   evidenced until the API is deployed and the agent enrols against it. Every
   underlying behaviour is unit-covered and the capture path is proven on real
   footage; what remains unproven is the composition. Tracked in `TASKS.md`.
2. **`session.stored` is defined but not emitted.** The phase-2 consumer does
   not exist. Recorded so it is not mistaken for working.
3. **Webcam capture is unimplemented.** There is no `/dev/video*` on this host.
   The track type exists and reports as an unavailable capability.

## Deviations

- The database is named `screencast` and the role `screencast_app`, not the
  `screencast_recorder`/`screencast_recorder_app` of the plan: the 45 live
  databases use short names, and matching the convention beat matching the plan.
- Nine planned Vault keys became thirteen, because the DSN was split into
  `DB_*` parts to match `mkrole.sh` and the ecosystem convention.
- The free-disk floor is 20 GB, not the planned 50 GB. Measured output is
  ~1.4 GB/hour rather than the assumed 8-12, so a four-hour session is ~6 GB.

## Recommendation

Accept with follow-up. The bootstrap is complete and independently evidenced;
the follow-up is item 1 above, to be recorded here once the deployed system has
been driven end to end.

## Traceability confirmation

The delivered system matches the approved intent: independent time-aligned
tracks, a privacy-safe activity index with no keystroke content, an explicit
operator Save before anything leaves the machine, verified storage, and a
session model that admits a second machine without redesign.
