# Vision: screencast-recorder

> Protected intent baseline. Human approval is required. This draft is derived
> from the owner's supplied requirements.

```yaml
id: VISION-screencast-recorder
status: draft
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-06
last_updated: 2026-09-06
completeness_level: complete-draft
```

## One-sentence vision

Turn the owner's multi-computer development sessions into synchronized,
structured source material that an AI editor can later transform into concise,
publishable YouTube videos with minimal manual editing.

## Problem statement

The work is distributed across several screens and potentially several
computers. A single conventional screen recording cannot represent this
activity correctly. Recording everything as one flattened video also makes
later editing unnecessarily expensive.

The system must therefore preserve the source tracks, their timing and the
operator's activity timeline.

## Target users

Primary: the owner/operator recording development work.

Secondary: automated post-production and publication services.

## Core user need

The operator needs to press Start once, work normally across the selected
computers/screens, press Stop once, and receive a reliable session that contains
everything required for later automatic editing.

## Phase 1 outcome

For the initial implementation, the complete workflow is:

```text
Web UI
  → discover Ubuntu sources
  → select sources
  → synchronize clock
  → prepare
  → scheduled synchronized start
  → record
  → graceful stop
  → Review
  → Save or Discard
  → verified MinIO session
```

The first implementation intentionally omits the MacBook. The same agent/session
protocol should support it later.

## Recording outputs

A session may contain:

1. one independent video track for each selected display;
2. one optional webcam video track;
3. one independent microphone/audio track;
4. activity metadata with pointer/click/keyboard-activity timing;
5. a manifest describing all tracks and timing.

The system must never store raw keyboard characters.

## Key outcomes

- **Low operator effort:** one web UI controls the complete capture session.
- **Reliable synchronization:** selected hosts start from a shared future `T0`.
- **Editable source material:** tracks remain independent.
- **Privacy-safe activity signal:** the editor can find active periods without a
  password/source-code keylog.
- **Resilient capture:** local recording continues through controller outages.
- **Safe storage:** accepted sessions are verified in MinIO before retention
  actions.
- **Future extensibility:** a MacBook becomes another agent rather than a
  second application architecture.

## Architecture boundary

The system consists of:

- a Kubernetes API/UI service for control, state and integrations;
- one host recording agent per graphical computer;
- local media storage during capture;
- MinIO as durable session storage.

The API must not be the data path for raw video frames. Video goes from the
capture host to local disk and then to S3.

## Activity metadata boundary

The purpose of activity metadata is temporal indexing for editing. It is not
surveillance.

Allowed examples:

- mouse position;
- pointer display;
- click count/type;
- keyboard activity count;
- modifier/hotkey category;
- application/process identity;
- sanitized window information.

Forbidden:

- raw key characters;
- clipboard contents;
- passwords/tokens/API keys;
- arbitrary sensitive text extracted from windows.

## Non-goals

### Current phase

- MacBook capture;
- AI editing;
- YouTube publication;
- automatic deletion;
- payments and business-domain integrations;
- generalized workflow orchestration for live capture.

### Architectural non-goals

- running desktop capture inside Kubernetes;
- introducing Temporal or another distributed workflow engine solely for the
  capture loop;
- using a general keylogger to infer activity.

## Success criteria

A valid phase-1 implementation can demonstrate:

- source selection from discovered host capabilities;
- synchronized start after NTP/chrony readiness;
- multiple independent screen tracks;
- optional webcam and microphone tracks when devices exist;
- activity metadata without raw keystrokes;
- graceful stop and finalized segments;
- Save/Discard review gate;
- verified MinIO storage;
- resilience to a temporary controller outage.

## Future state

```text
Stored session
    ↓
AI analysis / edit plan
    ↓
Rendered preview
    ↓
Human approval
    ↓
YouTube publication
    ↓
Human approval for raw retention deletion
```

The capture contract must remain stable across that transition.
