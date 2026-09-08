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

The control plane is deployed at `screencast.alfares.cz`, the host agent runs
as a systemd user service on `alfares`, and the whole pipeline has been driven
end to end against the real system rather than against mocks. 144 tests pass
across 19 suites.

A session started through the API recorded this host's 4K display and Jabra
microphone as independent segmented tracks, survived the API being scaled to
zero replicas for 45 seconds mid-recording without losing footage, stopped
gracefully with a playable final segment, and reached `stored` only after the
API independently read every object back from MinIO. A second session was
discarded and uploaded nothing.

That run found five defects no unit test had caught, each now fixed and pinned
by a regression test; they are listed under "End-to-end evidence" because how
they were found matters as much as that they were fixed.

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
| Capture survives an unreachable controller | Pass (live) | API scaled to 0 replicas for 45s mid-recording: all three ffmpeg processes stayed alive and segments grew from 2 to 4. No footage lost |
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
| Application | `npm run typecheck && npx jest` | Pass | 144 tests across 19 suites, both packages |
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
| Canonical service identity | SPOT link only; local role `internal:screencast-recorder:agent` enforced per route |

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

## End-to-end evidence (2026-09-07)

The system was deployed to `screencast.alfares.cz`, the agent installed as a
systemd user service, and the whole pipeline driven against it.

| Step | Observed |
| --- | --- |
| Enrolment | Agent enrolled and reported real capabilities; the console showed it online with HDMI-A-0 at 3840x2160, the Jabra, and the webcam unavailable |
| Start barrier | `preparing -> recording`, T0 set, clock offset recorded |
| Capture | Three ffmpeg processes; screen, audio and `events.jsonl` written to disk |
| Controller outage | API scaled to 0 for 45s: capture continued, segments grew 2 -> 4 |
| Stop | `recording -> review`; final short segment playable under ffprobe; manifest written locally and posted |
| Save | `review -> uploading -> stored`; agent logged `uploaded 4 objects (1624518 bytes), verified=true` |
| Storage layout | `<prefix>/alfares/{screen-HDMI-A-0,audio-...,metadata}/` with `manifest.json` at the session root |
| Discard | Reached `discarded` and uploaded nothing; only saved sessions had objects |
| Storage boundary | Scoped credential still denied on `speakasap-records`; that data untouched |

Four defects were found by this run that no unit test had caught, each fixed
with a regression test:

1. **Display offsets were rejected by the API.** The agent reports each
   display's position, which x11grab needs, but `DisplayDto` did not declare
   `x`/`y` and `forbidNonWhitelisted` turned that into a 400. The agent enrolled
   and then crash-looped.
2. **The agent read tracks from `start`.** The contract puts them in `prepare`,
   so the agent started zero processes and still reported "recording" -- a
   session that looked healthy while capturing nothing.
3. **Nothing completed a stop.** No handler acted on the agent's `stopped`
   report, so a finished recording sat in `stopping` with Save and Discard both
   unreachable.
4. **The `upload` command had no handler.** It fell through the switch to
   `default`, so Save moved the session to `uploading` and nothing was ever
   sent. A fifth followed it: the agent's directory layout omitted the hostname
   segment the API verifies against, so a complete upload was correctly refused
   as incomplete.

Every one was a silent failure of the kind this project's constitution forbids,
and each is now impossible to reintroduce without a failing test. 144 tests
across 19 suites pass.

## Issues and validation debt

1. **`session.stored` is defined but not emitted.** The phase-2 consumer does
   not exist. Recorded so it is not mistaken for working.
2. **Webcam capture is unimplemented.** There is no `/dev/video*` on this host.
   The track type exists and reports as an unavailable capability.
3. **A command consumed by a crashed agent is not redelivered.** `nextFor`
   stamps `deliveredAt` on handout, so an agent that dies between receiving a
   command and acting on it never sees it again. Observed while fixing defect 4
   above: the pending `upload` had already been marked delivered. Acceptable
   for a single-operator system where the console can re-issue, but it should
   become an acknowledgement before a second machine joins.

## Deviations

- The database is named `screencast` and the role `screencast_app`, not the
  `screencast_recorder`/`screencast_recorder_app` of the plan: the 45 live
  databases use short names, and matching the convention beat matching the plan.
- Nine planned Vault keys became thirteen, because the DSN was split into
  `DB_*` parts to match `mkrole.sh` and the ecosystem convention.
- The free-disk floor is 20 GB, not the planned 50 GB. Measured output is
  ~1.4 GB/hour rather than the assumed 8-12, so a four-hour session is ~6 GB.

## Recommendation

Accept. The bootstrap is complete, deployed, and evidenced end to end on the
real system: a session recorded from the console survived a 45-second
controller outage, stopped gracefully, and reached verified storage, while a
discarded session uploaded nothing.

## Traceability confirmation

The delivered system matches the approved intent: independent time-aligned
tracks, a privacy-safe activity index with no keystroke content, an explicit
operator Save before anything leaves the machine, verified storage, and a
session model that admits a second machine without redesign.
