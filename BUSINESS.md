# Business: screencast-recorder

> Protected business baseline. This document records the owner's supplied
> business intent. Human approval is required before it becomes an approved
> baseline.

```yaml
id: BUSINESS-screencast-recorder
status: approved
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-06
last_updated: 2026-09-06
completeness_level: complete
```

## Problem

The owner works across multiple computers and wants to publish YouTube videos
that show the actual development process. Manually reconstructing a 3–4 hour
work session from several computers, monitors, webcam footage and audio is too
slow and loses the timing information needed to identify useful moments.

The project therefore needs to turn a live work session into a synchronized,
structured set of source recordings that can later be edited automatically.

## Target users and stakeholders

Primary user: the operator/owner who records their own development work.

Secondary stakeholders:

- future AI post-production services;
- the YouTube publication workflow;
- ecosystem operators responsible for storage, authentication, logging and
  monitoring.

## Value proposition

A recording session should require almost no manual intervention after Start:

- select sources in a web form;
- start one synchronized session;
- work normally;
- stop once;
- explicitly save the session;
- hand the resulting structured source material to an AI editor.

The principal business metric is **editing time saved per published video**, not
the amount of footage recorded.

## Goals

1. Record one or more Ubuntu displays as separate video tracks.
2. Record optional webcam video and microphone audio as independent media.
3. Capture privacy-safe activity metadata sufficient to locate active work.
4. Synchronize the beginning of a session using NTP/chrony and a common start
   barrier.
5. Control the entire capture lifecycle from a web page.
6. Store accepted sessions in the dedicated MinIO S3 bucket.
7. Preserve a machine-readable manifest so a later AI editor can automatically
   select and assemble useful intervals.
8. Design the protocol so a MacBook can be added later without redesigning the
   session model.

## Non-goals

- MacBook implementation;
- AI editing and automatic highlight selection;
- preview rendering beyond capture/storage verification;
- YouTube upload;
- automatic deletion of raw footage;
- recording the contents of individual keystrokes;
- clipboard capture;
- making Kubernetes directly capture a graphical desktop.

## Success metrics

Phase 1 should demonstrate:

- a 3–4 hour session can be captured without manual per-track intervention;
- all selected tracks share a common session ID and timing origin;
- the operator can choose sources before recording;
- Stop produces finalized media plus `manifest.json` and activity metadata;
- Save uploads the complete session to MinIO and verifies it;
- an API outage during recording does not destroy the local capture;
- no raw keyboard contents or secret values enter media metadata.

The later product metric is that an AI-assisted editor can reduce a multi-hour
session to a substantially shorter publishable video without the operator
manually searching the complete raw recording.

## Business constraints

### Storage

Raw media is large. The system must use segmentation, configurable capture
quality and explicit retention rules. It must never silently delete the only
copy.

### Security and privacy

The system is intended for the owner's own computers. Nevertheless, raw
keystrokes are unnecessary and must not be captured. Secret values must never
be written to metadata, logs or Git.

### Ecosystem

The service must use the existing Alfares ecosystem conventions for Auth,
Vault, MinIO, logging, monitoring and onboarding rather than introducing
parallel infrastructure without approval.

### Operator control

Recording, saving and deleting source material are explicit operator actions.
The UI must make the current recording state unambiguous.

## Future business flow

```text
Record → Save → Preview → AI edit → Human approval → YouTube publish → Approve raw deletion
                              
```

Only the first two steps belong to the current capture phase.

## Approval

Status: approved.

Approved by: speakASAP <ssfskype@gmail.com>

Approval evidence: owner-confirmation:2026-09-06-owner-approved-business-constitution-vision

The owner reviewed the design section by section — architecture, data model,
control flow, orchestration split, and identity and secrets — approved the
written design at `docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`,
and then instructed "approve all three docs", meaning `BUSINESS.md`,
`docs/00_constitution/CONSTITUTION.md` and `docs/01_vision/VISION.md`.
