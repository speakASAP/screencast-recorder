# Project Invariants

```yaml
id: PROJECT-INVARIANTS
status: reviewed
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-06
last_updated: 2026-09-06
completeness_level: complete
```

## Purpose

These invariants protect the reliability, editability and security properties
that make the recorder useful.

## Invariants

| ID | Level | Rule | Forbidden outcome | Validation method | Gate |
|---|---|---|---|---|---|
| INV-001 | constitutional | Raw keyboard characters and clipboard contents are never persisted | Passwords/tokens/source text entering the recording metadata | activity-tracker tests + artifact inspection | pre-coding |
| INV-002 | constitutional | Displays, webcam, audio and encoders are discovered from the host | Broken hardcoded device configuration | capability discovery test | pre-release |
| INV-003 | constitutional | Selected hosts synchronize time before readiness and start from a future common `T0` | Multi-machine tracks with arbitrary network-arrival offsets | two-agent timing test | pre-release |
| INV-004 | constitutional | Screen, webcam and audio remain independent tracks | Irreversible flattening during capture | manifest/track inspection | pre-release |
| INV-005 | constitutional | Local media remains authoritative until Save/upload verification succeeds | Data loss after transient S3/API failure | failure-injection test | pre-release |
| INV-006 | constitutional | Runtime MinIO access is scoped to `screencast-sessions` | Access to unrelated buckets or root credentials at runtime | credential-scope test | pre-deploy |
| INV-007 | system | Stop is graceful and finalizes segments | Corrupt/unfinalized media after normal Stop | repeated start/stop integration test | pre-release |
| INV-008 | system | API outage does not terminate an active local recording | Recording loss caused by controller outage | disconnect-controller test | pre-release |
| INV-009 | system | Save and Discard are explicit operator decisions | Automatic destruction or publication of raw sessions | UI/state-machine test | pre-release |
| INV-010 | system | Phase-1 capture does not depend on AI, runlayer or BPCP availability | Live recording blocked by post-production services | dependency isolation test | pre-release |

## Exceptions

None approved.

## Review cadence

Review invariants when recording scope, privacy policy, storage semantics,
multi-machine synchronization or phase boundaries change, and before phase-2
post-production integration.

## Applicability

These invariants apply to every component in this repository — the Kubernetes
API service, the host-bound recording agent, and the provisioning scripts — and
to every agent or person changing them. They hold for phase 1 and continue to
hold for phase-2 post-production work unless the owner approves an explicit,
documented change to this file.
