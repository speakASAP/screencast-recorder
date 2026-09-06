# System: screencast-recorder

```yaml
id: SYSTEM-screencast-recorder
status: reviewed
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-06
last_updated: 2026-09-06
completeness_level: complete
```

## Purpose

Provide a reliable capture control plane and host-side recording agent that
turn a live development session into synchronized, independently editable
media tracks plus timing metadata.

## Responsibilities

### API/UI

- authenticate the operator;
- discover/register recording agents;
- create and control sessions;
- expose source selection;
- enforce the synchronized start barrier;
- persist session/track state;
- provide recording health;
- coordinate verified MinIO storage;
- emit lifecycle events.

### Ubuntu recording agent

- discover displays, webcam, microphones and encoders;
- synchronize/check system time;
- probe selected devices;
- start captures at the controller-supplied future `T0`;
- segment media;
- collect privacy-safe activity metadata;
- maintain local state during controller outages;
- gracefully stop and finalize media;
- upload and verify selected sessions.

## Non-responsibilities

- AI editing in phase 1;
- YouTube publication in phase 1;
- raw keyboard logging;
- clipboard surveillance;
- capturing video through the Kubernetes API;
- business workflow orchestration of live capture.

## Inputs

- authenticated web requests;
- agent registration/capability reports;
- start/stop commands;
- recording presets and source selections;
- NTP/chrony state;
- local display/audio/camera/GPU capabilities.

## Outputs

- local segmented media;
- `metadata/events.jsonl`;
- `manifest.json`;
- session/track state;
- structured logs and metrics;
- MinIO objects after explicit Save;
- `session.stored` lifecycle event.

## Core state machine

```text
preparing → recording → stopping → review → uploading → stored
                                  ↘ failed
review → discarded
```

The capture agent keeps local media authoritative through temporary controller
failure.

## Data model

### agents

`id`, `hostname`, `platform`, `capabilities`, `last_seen_at`, `status`,
`enrolled_at`.

### sessions

`id`, `title`, `status`, `started_at`, `ended_at`, `t0`, `clock_policy`,
`s3_prefix`, `disposition`, `retention_policy`.

### tracks

`id`, `session_id`, `agent_id`, `kind`, `source_ref`, `codec`, `fps`,
`segment_count`, `bytes`, `local_path`, `upload_state`, `degraded`.

## Track types

- `screen`: one track per selected display;
- `webcam`: optional camera track;
- `audio`: independent microphone track;
- `metadata`: JSONL activity/timing stream.

## Activity metadata

The tracker is an activity index, not a keylogger. It may record pointer
coordinates, display identity, click events/counts, keyboard activity counts,
modifier/hotkey categories, application/process identity and sanitized window
metadata.

It must never persist raw key characters or clipboard contents.

## Timing contract

All agents participating in a session synchronize their wall clocks with
NTP/chrony before readiness. The controller selects a future absolute `T0`.
Agents schedule capture against that `T0` rather than starting when a network
command happens to arrive.

Each track records:

- session ID;
- agent ID;
- source ID;
- start timestamp;
- media PTS origin;
- measured clock offset;
- segment time range.

## MinIO contract

Bucket: `screencast-sessions`.

Object prefix:

```text
sessions/<YYYY>/<MM>/<DD>/<session-id>/
```

Required objects:

```text
manifest.json
<agent>/<track>/seg-00000.<container>
metadata/events.jsonl
```

The API/agent uses the S3 API through a scoped non-root credential. The host
`mc` binary must not be assumed to be the MinIO client.

## Failure behavior

- API outage: continue local recording.
- Individual ffmpeg/source failure: mark track degraded where possible.
- Low disk: refuse start below threshold; stop safely at critical floor.
- Upload interruption: retry idempotently.
- Stop: graceful process termination and segment finalization.
- Missing optional device: disable that source rather than failing unrelated
  tracks.

## Dependencies

Required ecosystem capabilities are documented in
`docs/06_architecture/INTEGRATION_CONTRACT.md`.

## Validation criteria

A phase-1 implementation is complete only when a real recording demonstrates
source discovery, synchronized start, independent tracks, activity metadata,
graceful stop, Save/Discard and verified MinIO storage.

## Provisioned infrastructure (verified 2026-09-06)

These are live facts confirmed against the running cluster, not intentions.

| Resource | Value | Verification |
|---|---|---|
| Port | `3391` | Free in live K8s Services and `ECOSYSTEM_MAP.md`; outside the reserved `3380-3389` ai block |
| Database | `screencast` on `db-server-postgres:5432` | Created; naming follows the short-name convention (`cv`, `ai`, `runlayer`) |
| DB role | `screencast_app` | Non-superuser, no createrole, no createdb; owns all objects in `screencast`; `CONNECT` revoked from `PUBLIC` |
| MinIO bucket | `screencast-sessions` | Created via `mc` inside the MinIO pod |
| MinIO policy | `screencast-rw` | `s3:ListBucket` on the bucket; `Get/Put/DeleteObject` on its contents; nothing else |
| MinIO user | `screencast-recorder` (non-root) | Bound to `screencast-rw` |
| MinIO runtime credential | service account under that user | Verified able to read and write `screencast-sessions`, and **denied** on `speakasap-records`, `backups`, `cv-uploads`, `catalog-media`, `wisdom-quotes`, `school-committee`, and all admin operations |
| Vault path | `secret/prod/screencast-recorder` | Created; values never printed |

### Host capture environment (alfares)

| Property | Value | Consequence |
|---|---|---|
| Session | X11, `DISPLAY=:0` | `x11grab`; no Wayland portal required |
| Display | one, `HDMI-A-0`, 3840x2160 | Single screen track on this host |
| GPU | AMD Navi 33 (Radeon 7600) | `h264_vaapi` via `/dev/dri/renderD128`; the NVENC encoders ffmpeg lists have no matching hardware |
| Camera | none — `/dev/video*` absent | No webcam track until a camera is attached; reported as an unavailable capability |
| Microphone | Jabra Link 390 (PipeWire) | Audio track source |
| `mc` on host | GNU Midnight Commander 4.8.30 | Never use host `mc` for storage; the real client exists only at `/usr/bin/mc` inside the MinIO pod |
| Host S3 clients | none (`aws`, `mcli`, `rclone`, `boto3` all absent) | The agent uses the Node AWS SDK |

## Upstream traceability

This system implements the approved intent in [`BUSINESS.md`](BUSINESS.md) and
the product vision in
[`docs/01_vision/VISION.md`](docs/01_vision/VISION.md). The full technical
design, including the rejected alternatives and the reasoning behind the
capture/post-production split, is
[`docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`](docs/superpowers/specs/2026-09-06-screencast-recorder-design.md).
Governance constraints come from
[`docs/00_constitution/CONSTITUTION.md`](docs/00_constitution/CONSTITUTION.md)
and
[`docs/17_governance/PROJECT_INVARIANTS.md`](docs/17_governance/PROJECT_INVARIANTS.md).

## Downstream artifacts

- [`docs/06_architecture/INTEGRATION_CONTRACT.md`](docs/06_architecture/INTEGRATION_CONTRACT.md)
- [`docs/11_tasks/TASK-001-bootstrap-service.md`](docs/11_tasks/TASK-001-bootstrap-service.md)
- [`docs/12_validation/VAL-TASK-001-bootstrap-service.md`](docs/12_validation/VAL-TASK-001-bootstrap-service.md)
- [`docs/21_execution_plans/EP-TASK-001-bootstrap-service.md`](docs/21_execution_plans/EP-TASK-001-bootstrap-service.md)
- [`docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md`](docs/superpowers/plans/2026-09-06-screencast-recorder-foundation.md)

## Open questions

- Webcam capture is unimplemented because the host currently exposes no
  `/dev/video*` device. The track type is defined and reported as an
  unavailable capability; it needs validation once a camera is attached.
- The MacBook agent is designed but not implemented. The `T0` barrier and the
  per-agent storage prefix exist so that adding it does not change the session
  model, but the claim is unproven until a second agent runs.
- Phase-2 post-production ownership is settled in principle — BPCP owns the
  approval-gated process, `ai-microservice` performs the render — but the event
  payload beyond `session.stored` is not yet specified.
- Retention is `retain-until-published` and nothing deletes raw footage in
  phase 1. The deletion trigger becomes real only when YouTube publication
  exists.
