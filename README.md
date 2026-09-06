# screencast-recorder

`screencast-recorder` is the capture and session-control service for producing
YouTube-ready recordings of development work. The system records the selected
Ubuntu displays as independent screen tracks, optional webcam video and
microphone audio, plus privacy-safe activity metadata. A later post-production
pipeline can use that material to reduce a multi-hour work session to a short
video without asking the operator to manually find every useful interval.

## Current scope

**Phase 1 is capture-first and Ubuntu-only.** The immediate test target is one
Ubuntu workstation/server with its directly attached displays, webcam and
microphone. MacBook support is designed as a second recording agent but is not
required for the first implementation.

The web UI is the operator control plane:

1. discover available recording sources;
2. select exactly what to record;
3. synchronize the recording host clock;
4. start/stop a session;
5. monitor health, disk space and track progress;
6. review the captured session;
7. explicitly save it to the dedicated MinIO bucket or discard it.

The raw capture agent runs on the Ubuntu graphical host, not inside Kubernetes,
because it needs direct access to X11/Wayland, PipeWire, camera devices and GPU
encoding.

## Important design decision

Do **not** implement a traditional keylogger.

The editor needs activity timing, not the contents of passwords, tokens or
source code. The agent therefore records:

- pointer position and pointer-display identity;
- click events/counts;
- keyboard activity counts;
- modifier/hotkey categories where useful;
- focused application/process identity;
- optional sanitized window metadata.

It never records raw keystrokes or clipboard contents. This substantially
reduces security and privacy risk while retaining the signal needed to locate
active work.

## Architecture

```text
Browser
   │ HTTPS
   ▼
screencast-recorder API/UI ───────► PostgreSQL
   │                                  session state
   │
   │ command/control
   ▼
Ubuntu recording agent
   ├── screen capture #1 ──┐
   ├── screen capture #2 ──┤
   ├── screen capture #N ──┤
   ├── webcam ─────────────┤──► local session directory
   ├── microphone ─────────┤
   └── activity metadata ──┘
                  │
                  │ explicit Save + verified upload
                  ▼
             MinIO S3
        screencast-sessions

Phase 2:
MinIO session → AI editing pipeline → preview → human approval → YouTube
```

The API is the Kubernetes ecosystem service. The recording agent is a
host-bound device process. This split is deliberate: Kubernetes should not be
given direct access to the graphical desktop, camera, microphone or `/dev/dri`.

## Recording model

Each selected source is an independent track. A session should normally
contain:

- `screen/<display>` — one video track per selected display;
- `webcam/<camera>` — optional video track;
- `audio/<microphone>` — audio track;
- `metadata/events.jsonl` — activity/timing metadata;
- `manifest.json` — authoritative timing and track manifest.

Tracks are segmented locally (default 60 seconds). Segmentation limits crash
loss and allows later editing to discard whole intervals without re-encoding
the complete source.

The exact codec, resolution, FPS and hardware encoder are capabilities/preset
choices, not assumptions embedded in the web UI.

## Synchronization

The session start is a **barrier**, not an immediate broadcast:

1. every selected agent confirms NTP/chrony synchronization;
2. every selected source is probed and disk capacity is checked;
3. the controller chooses a future absolute `T0`;
4. every agent receives the same `T0`;
5. each agent starts capture at its local `T0`;
6. each agent writes its measured clock offset and capture start timestamp to
   the manifest.

For the single-Ubuntu test this still uses the same barrier, so the eventual
multi-machine design does not need to be replaced later.

A short audible start beep is emitted by the agent immediately before capture.
Stop also emits a distinct beep after capture processes have finalized.

## Storage and MinIO

Use a dedicated bucket:

`screencast-sessions`

The service uses the MinIO **S3 API** through the AWS SDK (or an equivalent
S3-compatible client). It must not invoke the host `mc` command: on the
described Ubuntu system `mc` may be Midnight Commander rather than the MinIO
client.

Runtime credentials are scoped to `screencast-sessions` and are stored through
Vault/External Secrets. The recording service must never use MinIO root
credentials.

The save operation is transactional from the operator's perspective:

```text
local recording
    ↓
upload segments + manifest
    ↓
verify object existence/checksums
    ↓
mark session stored
```

Only after a successful explicit save and verification may a future retention
policy delete local raw files. Phase 1 must not silently delete recordings.

## Web UI

### New session

- session title;
- recording agent;
- checkboxes for discovered displays;
- optional webcam;
- audio input;
- capture preset;
- free-disk estimate;
- estimated maximum recording duration;
- Start button.

The source list must come from agent capability discovery. A missing webcam is
an unavailable capability, not an application error.

### Recording

Show:

- elapsed time;
- current state;
- selected tracks;
- per-track segment count and bytes;
- free disk space;
- capture errors/degradation;
- activity heartbeat;
- Stop button.

### Review

After Stop:

- show duration and captured tracks;
- show basic thumbnails/metadata;
- ask **Save session** or **Discard session**;
- never upload before Save.

### Sessions

Show stored sessions and their MinIO prefixes. Later this screen becomes the
entry point for preview, AI editing and YouTube publication.

## Phase 1 / Phase 2 boundary

Phase 1 ends at a verified stored session.

Phase 2 adds:

- AI-assisted selection and editing;
- preview rendering;
- human approval;
- YouTube publication;
- explicit raw-footage retention/deletion workflow.

The phase-1 manifest and event schema must therefore be designed for the phase-2
editor now.

## Ecosystem integrations

Required:

- `auth-microservice` — human UI authentication and agent identity;
- PostgreSQL — session/agent/track state;
- `minio-microservice` — S3 media storage;
- `logging-microservice` — structured operational logs;
- monitoring — health and recording-agent metrics;
- docs-RAG — service documentation discovery;
- RabbitMQ/event bus — lifecycle events such as `session.stored`.

Not required in phase 1:

- `ai-microservice` — post-production is phase 2;
- notifications — a single operator is monitoring the UI;
- Redis — no distributed queue/lease is required for capture;
- payments/catalog/orders/warehouse/invoices — no domain relationship.

`runlayer` is not the live recording engine. Capture is a host-local state
machine because recording must continue if the API becomes temporarily
unavailable. Later, runlayer/BPCP may participate in post-production workflows
where durable business orchestration is appropriate.

## Deployment

- API/UI: Kubernetes, namespace `statex-apps`, port `3391`, domain
  `screencast.alfares.cz`.
- Recording agent: systemd **user** service on the graphical Ubuntu session.
- MinIO: existing `minio-microservice`; use its S3 endpoint and dedicated
  bucket.
- Secrets: Vault + External Secrets for Kubernetes; AppRole for the
  host-side agent where required by the ecosystem standard.

## Development

Implementation must follow the repository's documentation-first onboarding
flow and the intent-preservation chain:

```text
Vision → Goal Impact → System → Feature → Task → Plan → Code → Validation
```

Do not implement application code while required integration contracts,
invariants or validation criteria are unresolved.

## Health and failure behavior

The agent must continue capturing through a temporary API outage. Local files
are the source of truth until the session is saved.

The agent must refuse to start when free disk is below the configured safety
threshold. If a track fails, the session should remain alive where possible and
mark that track degraded rather than corrupting the entire session.

Stopping must be graceful (`SIGINT`/equivalent) so segmented media is finalized.

## Related documents

- [`BUSINESS.md`](BUSINESS.md)
- [`SYSTEM.md`](SYSTEM.md)
- [`TASKS.md`](TASKS.md)
- [`docs/00_constitution/CONSTITUTION.md`](docs/00_constitution/CONSTITUTION.md)
- [`docs/01_vision/VISION.md`](docs/01_vision/VISION.md)
- [`docs/06_architecture/INTEGRATION_CONTRACT.md`](docs/06_architecture/INTEGRATION_CONTRACT.md)
- [`docs/17_governance/PROJECT_INVARIANTS.md`](docs/17_governance/PROJECT_INVARIANTS.md)
