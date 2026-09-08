# Screencast Recorder — Capture Platform Design

```yaml
id: DESIGN-screencast-recorder
status: approved
owner: project owner
created: 2026-09-06
last_updated: 2026-09-06
phase: 1 (capture only)
```

## Purpose

Record multi-machine desktop work as separate, time-aligned media tracks plus an
activity-metadata stream, store them in MinIO, and preserve enough timing data
that a later AI editing stage can cut a 3–4 hour session into a short YouTube
video without re-recording anything.

Phase 1 delivers capture, storage and operator control only. Editing,
preview-beyond-verification, YouTube publication and raw-footage deletion are
phase 2 and are explicitly out of scope here, but their event contracts are
defined now so phase 2 needs no schema change.

## Verified environment facts

Established by direct inspection on `alfares`, 2026-09-06:

| Fact | Value | Consequence |
|---|---|---|
| Session type | X11, `DISPLAY=:0` | `x11grab` is usable; no Wayland portal needed |
| Displays | 1 × `HDMI-A-0`, 3840x2160 | Single screen track on this host |
| GPU | AMD Navi 33 (Radeon 7600) | `h264_vaapi` via `/dev/dri/renderD128`; NVENC listed but no NVIDIA hardware |
| Cameras | none — `/dev/video*` absent | No webcam track in phase 1; capability-reported, not hardcoded |
| Audio in | Jabra Link 390 mono source; Generic USB Audio | Mic track from PipeWire |
| `mc` on host | Midnight Commander, **not** MinIO client | Never shell out to `mc` for uploads; real `mc` exists at `/usr/bin/mc` inside the MinIO pod |
| Host S3 clients | none (`aws`, `mcli`, `rclone`, `boto3` all absent) | Agent uses the Node AWS SDK |
| MinIO | k8s `statex-apps`, `https://minio.alfares.cz`, data `/srv/speakasap-records` (~618G live) | New bucket only; never touch `speakasap-records` |
| Vault | unsealed, `http://127.0.0.1:8200` | Plain HTTP locally |
| Free ports | 3391–3394 (3380–3389 is the reserved `ai` block) | API on **3391** |

## Architecture

Two deployables, one repository.

**`api/` — NestJS, Kubernetes `statex-apps`, port 3391, `screencast.alfares.cz`**

The onboarded ecosystem service. Owns the web UI, session/agent/track state in
PostgreSQL, the MinIO S3 client, `GET /health`, structured logging, Auth
integration, docs-RAG registration and the catalog entry. Auto-deploys on commit
to `main` through the shared deploy queue.

**`agent/` — Node process, systemd **user** unit on each recording machine**

Owns no durable state. Registers with the API, reports its discovered
capabilities, long-polls for commands, supervises ffmpeg and the activity
tracker, uploads segments to MinIO, sends heartbeats. Runs as `ssf` inside the
graphical session because it needs the X11 socket, the PipeWire socket and
`/dev/dri`. A system-level unit cannot reach these; this is why the agent is not
a pod.

### Why split

A single k8s service cannot capture a desktop, and a single host process cannot
satisfy the ecosystem deployment standard. The split lets the API be a fully
standard-compliant service while the agent stays a thin, host-bound device
driver.

Adding the MacBook later is an agent registration plus a capture-module swap
(`avfoundation` for `x11grab`, launchd for systemd). No API change. A session
spanning both machines is two agents receiving one `session_id` and one `T0`.

### Capture strategy

- **Screen:** `x11grab` on `:0.0` → `h264_vaapi`, **15 fps** default, segmented
  into **60-second chunks** via `-f segment`.
- **Audio:** PipeWire → Jabra source → AAC, its **own file**, never muxed into
  the screen track.
- **Metadata:** one JSONL stream at 5 Hz.

Three decisions do the heavy lifting for phase 2:

1. **Segmentation** lets the editor drop whole chunks with `-c copy` — no
   re-encode — and caps crash loss at 60 seconds.
2. **Separate tracks** let the editor recombine audio and video independently.
3. **15 fps** reflects that screencasts of code are near-static; it roughly
   halves the byte volume against 30 fps with no perceptual loss for this
   content.

## Data model

Dedicated PostgreSQL database with a least-privilege service role.

**`agents`** — `id`, `hostname`, `platform` (`linux`/`darwin`), `capabilities`
JSONB, `last_seen_at`, `status`, `enrolled_at`.

`capabilities` is reported by the agent at registration, never hardcoded: the
displays, audio inputs, cameras and encoders it actually found. This is what
makes the web form's source list correct on any machine, and why the absent
webcam renders as an unavailable option rather than a broken one.

**`sessions`** — `id` (uuid), `title`, `status`, `started_at`, `ended_at`,
`clock_offset_ms`, `s3_prefix`, `disposition`, `retention_policy`.

`status`: `preparing → recording → stopping → review → uploading → stored`,
plus terminal `discarded` and `failed`.

`review` is the save/discard gate: recording has stopped, files are still local,
and nothing reaches S3 until the operator decides.

`retention_policy` defaults to `retain-until-published`. Phase 1 contains no
process that deletes raw footage.

**`tracks`** — `id`, `session_id`, `agent_id`, `kind`
(`screen`/`audio`/`webcam`/`metadata`), `source_ref`, `codec`, `fps`,
`segment_count`, `bytes`, `local_path`, `upload_state`, `degraded`.

## Storage layout

Bucket **`screencast-sessions`** (new, dedicated):

```text
sessions/<YYYY>/<MM>/<DD>/<session-id>/
  manifest.json
  alfares/screen-HDMI-A-0/seg-00000.mp4 …
  alfares/audio-jabra/seg-00000.m4a
  alfares/metadata/events.jsonl
  macbook/…                              # phase 2, same shape
```

`manifest.json` is the contract the phase-2 editor consumes: session bounds,
every track with its start PTS and per-segment time ranges, the recorded clock
offset, and activity spans derived from the metadata stream. It is written at
stop time even though no editor exists yet — omitting it is what would force
re-recording later.

## Activity metadata

Captured at 5 Hz into `events.jsonl`:

```json
{"ts": 1757155200.0, "agent": "alfares", "display": "HDMI-A-0",
 "window": "nvim — screencast-recorder", "mouse": [1204, 830],
 "clicks": 2, "keys": 17, "hotkeys": ["ctrl+s"]}
```

**Keystroke content is never recorded.** Counts and modifier/hotkey names only.
The signal an editor needs is "which screen was active and how busy" — that is
fully carried by counts. Recording characters would place passwords, tokens and
keys into S3 and then into an AI editing pipeline, for no editing benefit.

## Control flow

**Start** — an ordered barrier, not a broadcast:

1. API creates the session, dispatches `prepare` to each selected agent.
2. Each agent runs `chronyc waitsync`, probes its sources, checks free disk, and
   records its clock offset.
3. Each agent reports `ready` or a specific failure.
4. Only when **every** selected agent is ready does the API broadcast `start`
   with a shared `T0`.
5. Each agent emits the audible beep and spawns ffmpeg.

If any agent fails to ready up, nothing starts and the UI names the agent and
the reason. This is the requirement that recording begins only after clocks
agree, enforced as a barrier rather than assumed.

**Stop:** `SIGINT` to ffmpeg — never `SIGKILL`, which leaves an unfinalized MP4
— wait for exit, finalize the last segment, write `manifest.json`, beep, move
the session to `review`.

## Web UI

Served by the API behind Auth. Four screens:

1. **New session** — live agent list; per-agent source checkboxes built from
   reported capabilities; quality preset; title. Start.
2. **Recording** — elapsed time, per-track bytes and segment counts, free disk,
   and a live active-window readout so the tracker is visibly alive. Stop.
3. **Review** — save/discard, with thumbnails, duration and total size.
4. **Sessions** — stored sessions, sizes, S3 prefixes.

## Failure handling

- **Disk fills.** 4K/15fps VAAPI ≈ 8–12 GB/hour; a 4-hour session ≈ 50 GB. The
  agent refuses to start below a free-space threshold and force-stops cleanly at
  a floor during recording, rather than letting ffmpeg die dirty and corrupt the
  tail.
- **ffmpeg dies.** The supervisor marks that track `degraded` and keeps the
  other tracks running. One source is lost, not the session.
- **API unreachable mid-recording.** The agent keeps recording. Local files are
  the source of truth; the API is a controller, not a dependency. State
  reconciles on reconnect. This is why the agent long-polls rather than the API
  pushing.
- **Upload interrupted.** Segments upload independently with retry; a resumed
  upload skips completed objects.
- **Vault sealed after host reboot.** The API's ExternalSecret fails and the pod
  will not start; the agent surfaces "controller unavailable" instead of
  silently recording into a void.

**Local retention.** Phase 1 never deletes anything automatically.

Raw footage is deleted on exactly two paths, and preview is not a
deletion trigger on either of them.

**The session was no good.** The operator previews it, marks it unusable, and
asks for the whole session to be deleted. Deletion is that explicit request,
never a consequence of having looked.

**The session was published.** The full chain completes -- edit, preview,
approval, YouTube publication -- and only once a real YouTube link exists are
the sources replaced by that link and the final video. Nothing is deleted while
the material is still needed to produce the video.

Preview exists so the operator can see what was recorded. That is all it does.
It informs the first path and precedes the second, but it authorises neither.

## Orchestration

Deliberately split by timescale.

**Capture is a local state machine** in this service's own PostgreSQL — the
`sessions.status` column is the workflow. It must survive the controller being
down, so it delegates nothing. Temporal was considered and rejected: a new
server, database, SDK and deployment for one workflow run a few times a week,
against a standard that forbids parallel infrastructure. runlayer and BPCP were
also considered and rejected for this half — runlayer orchestrates project
execution and marks object storage not-applicable; BPCP owns business process
definitions and does not mutate domain databases. Neither is a general job
runner, and routing live recording state through them would put capture
liveness behind two more services.

**Post-production is an ecosystem process** (phase 2): `stored → edit requested
→ ai-microservice renders → preview ready → owner approves → YouTube publish →
owner approves deletion → purge raw`. Long pauses and human approval gates are
exactly BPCP's purpose. This service emits events to RabbitMQ; BPCP owns the
definition and the gates; ai-microservice performs the render.

Phase 1 therefore stops at `stored` and emits `session.stored` for a consumer
that does not exist yet.

## Identity and secrets

**Vault path `secret/prod/screencast-recorder`** — key names and purposes only:

| Key | Purpose |
|---|---|
| `SCREENCAST_DATABASE_URL` | Dedicated database and least-privilege role |
| `MINIO_ENDPOINT_URL` | `https://minio.alfares.cz` |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Scoped service account, `screencast-sessions` only |
| `MINIO_BUCKET` | `screencast-sessions` |
| `AGENT_ENROLLMENT_SECRET` | Response-wrapped AppRole `secret_id` delivery at enrollment |
| `AGENT_BEARER` | Pair token `svc-screencast-agent--screencast-recorder`, read by the agent over AppRole |
| `LOGGING_SERVICE_URL`, `AUTH_SERVICE_URL`, `MONITORING_SERVICE_URL` | Declared for parity |

Every key gets an explicit `data:` entry in `k8s/external-secret.yaml`. A Vault
key absent from the ExternalSecret never reaches the pod while ESO still reports
`Synced` — a known, previously observed failure in this ecosystem.

**Scoped MinIO credential — no root at runtime.** This does not exist yet and
must be provisioned; `minio-microservice` has no scoped-credential tooling
today, so it is new work belonging in that repository.

Provisioning, with the real `mc` inside the MinIO pod:

1. Create policy `screencast-rw` granting `s3:GetObject`, `s3:PutObject`,
   `s3:DeleteObject` and `s3:ListBucket` on `arn:aws:s3:::screencast-sessions/*`
   and nothing else.
2. Create a dedicated **non-root** MinIO user `screencast-recorder` and attach
   that policy to it.
3. Create a **service account** (`mc admin user svcacct add`) under that user.
   A MinIO service account is a child credential whose inline policy can only
   narrow its parent's permissions, never widen them.

The root credential is required once, at provisioning time, because MinIO admin
operations demand it. **Nothing at runtime uses root.** The service's runtime
identity is the scoped service account, which cannot address
`speakasap-records` at all — the boundary is enforced by policy, not by our code
being careful.

**Auth — two separate lanes:**

- *Human:* user-facing application registered through
  `POST /auth/admin/applications/register`, `type: user_facing`, domain
  `screencast.alfares.cz`, with the application-scoped default role
  `app:screencast-recorder:user`. Without that exact role, a valid login fails
  after credential verification.
- *Machine:* follow only
  [`SERVICE_IDENTITY_CONSUMER_STANDARD.md`](../../../auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md).
  Local pair: `svc-screencast-agent--screencast-recorder@internal.alfares.cz`,
  role `internal:screencast-recorder:agent`.

**Agent credential delivery — Vault AppRole (no pod).**
ExternalSecret delivers credentials to pods. The agent has no pod, so it uses
the ecosystem host-side path to the same Vault path
(`secret/prod/screencast-recorder`): **AppRole**, already used by `allegro`,
`aukro`, `bazos`, `flipflop` and `heureka`.

- The agent authenticates to Vault by AppRole. `role_id` sits in its config; the
  `secret_id` is delivered response-wrapped at enrollment.
- The pair token is read from Vault at startup and on rotation. The agent never
  mints or self-signs.
- The API enforces `internal:screencast-recorder:agent` per route.

## Integration contract decisions

| Capability | Decision | Reason |
|---|---|---|
| auth | required | Operator login and agent service identity |
| postgres | required | Session, agent and track state |
| object-storage | required | Session media |
| logging | required | Ecosystem mandatory |
| monitoring | required | Ecosystem mandatory; `/health` and probes |
| docs-rag | required | Ecosystem mandatory |
| event-bus | required | Emits `session.stored` for phase-2 post-production |
| ai | not-applicable (phase 1) | Editing is out of scope; becomes required in phase 2 |
| notifications | not-applicable | A single operator watches a live UI |
| redis | not-applicable | No queueing, leasing or dedup requirement |
| backups | not-applicable | Raw media is deliberately not backed up |
| payments, catalog, orders, warehouse, invoices | not-applicable | No domain relationship |

## Deployment

- **API:** Kubernetes, auto-deploy on commit to `main` via the shared deploy
  queue.
- **Agent:** systemd **user** unit (`systemctl --user`), installed by script.
  Not eligible for the deploy queue; it is host software, not a workload.

## Out of scope for phase 1

Webcam capture (no camera present), MacBook agent, AI editing, preview rendering
beyond upload verification, YouTube publication, and automatic deletion of raw
footage.

## Onboarding

Follows `register-new-app` in full: harness scaffold, runtime identity and
secret baseline, intent and integration planning, ecosystem catalog
registration, then implementation and validation. Port 3391 is verified free
against both `ECOSYSTEM_MAP.md` and live Kubernetes services, and sits outside
the reserved 3380–3389 `ai` block.
