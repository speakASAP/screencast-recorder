# Project Constitution: screencast-recorder

> Protected document. Human approval is required. AI agents may draft from
> owner-provided intent, but must not silently change an approved baseline.

```yaml
id: CONSTITUTION-screencast-recorder
status: approved
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-06
last_updated: 2026-09-06
completeness_level: complete
```

## Purpose

This constitution protects the core property of the project: capture should
make the owner's multi-hour computer work available for efficient later
editing, without requiring the owner to operate a complicated recording setup
or exposing unnecessary sensitive input data.

## Constitutional principles

### 1. Capture first, edit later

The recorder's primary responsibility is producing reliable, synchronized raw
source material. AI editing, preview generation and YouTube publication are
separate phases.

### 2. Host-bound capture, ecosystem-standard control plane

Desktop capture must execute on the recording host because display, audio,
camera and GPU devices belong to that host. The Kubernetes service controls
sessions and stores state, but it must not pretend that a pod is a desktop
capture environment.

### 3. Separate tracks are mandatory

Displays, webcam and audio are independent tracks. The system must not flatten
them into a single irreversible video during capture.

This preserves maximum freedom for the later editor.

### 4. Time alignment is a first-class contract

Every session has a common `session_id` and timing origin. Recording starts only
after the selected hosts report synchronized clocks and source readiness.

For multiple machines, the controller sends a future absolute `T0` rather than
relying on network message arrival times.

### 5. No traditional keylogger

The system must never persist raw keyboard characters or clipboard contents.
It may record activity counts, modifier/hotkey categories, pointer position,
clicks and safe application identity because those signals support editing.

This is a non-negotiable security boundary.

### 6. Local source of truth

While recording, local media is authoritative. Temporary API, Kubernetes or
network failures must not destroy an otherwise valid capture.

### 7. Explicit save and retention

Stopping a session does not mean deleting anything. The operator explicitly
chooses Save or Discard. A future deletion operation must verify the S3 copy
before removing local raw data and must be a separate, auditable action.

### 8. Least privilege

MinIO runtime credentials are scoped to the dedicated
`screencast-sessions` bucket. Root credentials are provisioning-only. Auth
identities follow the ecosystem's sanctioned service-identity standard.

### 9. Capability discovery

The UI must not hardcode displays, cameras, microphones or encoders. The agent
reports what the current host actually exposes, and the UI enables only those
sources.

### 10. Onboarding and ecosystem compliance

The project follows the repository's `register-new-app` onboarding workflow,
intent-preservation chain, shared deployment standard and integration
contracts. Unknown ecosystem facts are recorded as unknown rather than
invented.

## Human approval gates

The owner must approve changes to:

- recording scope or privacy boundaries;
- raw-input telemetry policy;
- public authentication model;
- MinIO bucket or credential scope;
- automatic publishing or automatic deletion.

## Validation principle

A task is complete only when its acceptance criteria have executable or
observable evidence. A green process exit code is insufficient when the actual
resource, track, credential scope or timing guarantee has not been verified.

## Amendment process

1. Create an amendment under `docs/17_governance/amendments/`.
2. State the requested change and its reason.
3. Identify affected vision, system, integration and validation artifacts.
4. Obtain human approval.
5. Update dependent artifacts.
6. Rerun the relevant onboarding and validation gates.

## Approval

Status: approved.

Approved by: speakASAP <ssfskype@gmail.com>

Approval evidence: owner-confirmation:2026-09-06-owner-approved-business-constitution-vision

The owner reviewed the design section by section — architecture, data model,
control flow, orchestration split, and identity and secrets — approved the
written design at `docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`,
and then instructed "approve all three docs", meaning `BUSINESS.md`,
`docs/00_constitution/CONSTITUTION.md` and `docs/01_vision/VISION.md`.
