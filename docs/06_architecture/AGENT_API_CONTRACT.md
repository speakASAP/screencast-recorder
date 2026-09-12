# Agent ↔ API HTTP Contract

```yaml
id: CONTRACT-agent-api
status: approved
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-06
last_updated: 2026-09-06
completeness_level: complete
upstream:
  - ../../SYSTEM.md
  - ../superpowers/specs/2026-09-06-screencast-recorder-design.md
```

## Why this document exists

The API service and the host agent are built as independent workstreams. This
contract is the only thing they share, so it is fixed before either is written.
Changing it later means changing both.

## Transport and authentication

All calls are agent → API over HTTPS to `https://screencast.alfares.cz`. The
agent never listens on a port; the API never connects to the agent. This
direction is deliberate: the agent runs on a workstation with no stable inbound
address, and it must keep recording when the API is unreachable.

Machine auth follows only
[`SERVICE_IDENTITY_CONSUMER_STANDARD.md`](../../../auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md).
Local inventory: identity
`svc-screencast-agent--screencast-recorder@internal.alfares.cz`, role
`internal:screencast-recorder:agent` on every route below. The agent loads the
pair token from Vault via AppRole.

Operator (browser) routes authenticate separately through hosted Auth with
`app:screencast-recorder:user`. They are not part of this contract.

## Identifiers

- `agent_id` — UUID assigned by the API at first enrollment, persisted by the
  agent in its local state file.
- `session_id` — UUID assigned by the API.
- `track_id` — UUID assigned by the API when a session is created.

Times are RFC 3339 with explicit offset, always UTC (`2026-09-06T18:30:00Z`).
Durations are seconds. Sizes are bytes.

## Routes

### `POST /api/agents/enroll`

First contact. Idempotent on `hostname` + `machine_id`.

```jsonc
// request
{
  "hostname": "alfares",
  "machine_id": "9f1c...",        // /etc/machine-id, stable across reboots
  "platform": "linux",            // linux | darwin
  "agent_version": "0.1.0"
}
// 200
{ "agent_id": "uuid", "poll_interval_seconds": 5 }
```

### `POST /api/agents/{agent_id}/capabilities`

Reported at every startup, because hardware changes: a camera gets plugged in,
a monitor is unplugged. The UI builds its source list from the newest report,
which is why no display, encoder or device is ever hardcoded in the frontend.

```jsonc
{
  "displays": [
    { "id": "HDMI-A-0", "width": 3840, "height": 2160, "refresh_hz": 60, "primary": true }
  ],
  "audio_inputs": [
    { "id": "alsa_input.usb-_Jabra_Link_390...", "label": "Jabra Link 390", "channels": 1 }
  ],
  "cameras": [],                            // empty is normal, not an error
  "encoders": ["h264_vaapi", "libx264"],
  "session_type": "x11",                    // x11 | wayland
  "free_disk_bytes": 412000000000,
  "clock": { "synchronised": true, "offset_ms": 3, "source": "chrony" }
}
// 200 { "accepted": true }
```

### `GET /api/agents/{agent_id}/commands`

Long poll, up to 25 seconds. Returns `204` when there is nothing to do. The
agent reconnects immediately after any response.

```jsonc
// 200 — exactly one command
{
  "command_id": "uuid",
  "type": "prepare",              // prepare | start | stop | abort
  "session_id": "uuid",
  "issued_at": "2026-09-06T18:29:55Z",
  "payload": { }                  // per type, below
}
```

**Idempotency.** Commands are at-least-once. The agent records every applied
`command_id` **durably**, so a repeat is recognised across a restart as well as
within one process, and ignores it. A redelivered `start` after `T0` has passed
must not spawn a second capture.

**Delivery and acknowledgement.** Handing a command out does not retire it.
A command is offered again if it is not acknowledged within a **30-second
lease**, so an agent that dies between receiving a command and acting on it is
handed that command again when it comes back rather than losing it: before
this, a pending `stop` was silently dropped and its session sat in `stopping`
for ever.

The lease is just over the 25-second poll window, so an agent that receives and
applies a command always acknowledges inside it. A long-running command
(`render-preview`, `upload`) can outlast the lease and be redelivered while it
is still working; the agent's durable applied-set absorbs that as a duplicate.

After **3 deliveries** without an acknowledgement the command is abandoned: its
session is failed with `command_unacknowledged` if it is still in a state that
can legally fail, and otherwise the command is simply retired. Without the cap,
a command that kills the agent on arrival is a silent restart loop — crash,
restart, poll, crash.

### `POST /api/agents/{agent_id}/commands/{command_id}/ack`

The agent confirming it applied a command. Sent **after** the work, so a crash
mid-handling leaves the command eligible for redelivery. Acknowledging is
idempotent, and scoped to the agent in the path: an ack cannot retire another
machine's command. A duplicate is acknowledged too — it exists precisely
because the first delivery was not, and leaving it unacknowledged would walk it
to the abandonment cap and fail a healthy session.

```jsonc
// 200
{ "accepted": true }
```

#### `prepare` payload

```jsonc
{
  "tracks": [
    { "track_id": "uuid", "kind": "screen", "source_ref": "HDMI-A-0",
      "codec": "h264_vaapi", "fps": 15, "segment_seconds": 60 },
    { "track_id": "uuid", "kind": "audio",  "source_ref": "alsa_input...",
      "codec": "aac", "bitrate_kbps": 192, "segment_seconds": 60 },
    { "track_id": "uuid", "kind": "metadata", "source_ref": "activity",
      "sample_hz": 5 }
  ],
  "min_free_gb": 50
}
```

The agent synchronises its clock, probes every listed source, checks free disk,
and reports readiness. It starts nothing.

#### `start` payload

```jsonc
{ "t0": "2026-09-06T18:30:00Z" }
```

An absolute future instant, not "start now". Each agent schedules against its
own synchronised clock, so two machines begin together even when the command
arrives at different times. If `t0` is already past on arrival by more than
`2s`, the agent reports `failed` with `t0_missed` rather than starting late and
silently misaligning the tracks.

### `POST /api/sessions/{session_id}/status`

The agent's report after `prepare`, and on every state change.

```jsonc
{
  "command_id": "uuid",
  "agent_id": "uuid",
  "state": "ready",   // ready | recording | stopping | stopped | failed
  "clock": { "synchronised": true, "offset_ms": 3 },
  "free_disk_bytes": 412000000000,
  "reason": null      // required when state is failed
}
```

The API starts a session only when **every** selected agent reports `ready`. If
any reports `failed`, no agent is sent `start`, and the UI names the agent and
the reason.

Failure reasons are a closed set, so the UI can explain them:
`clock_unsynchronised`, `source_missing`, `disk_below_threshold`,
`encoder_unavailable`, `t0_missed`, `ffmpeg_failed`, `internal_error`,
`command_unacknowledged`.

`command_unacknowledged` is the one reason the API raises on its own behalf
rather than relaying from an agent: it means a command reached the delivery cap
without ever being acknowledged, so the session cannot be driven any further.

### `POST /api/sessions/{session_id}/progress`

Heartbeat during recording, every 5 seconds. Also the liveness signal: the UI
shows a session as degraded when progress stops arriving.

```jsonc
{
  "agent_id": "uuid",
  "tracks": [
    { "track_id": "uuid", "segments": 47, "bytes": 5910000000, "degraded": false }
  ],
  "free_disk_bytes": 361000000000,
  "active_window": "nvim — screencast-recorder"   // for the operator's liveness readout
}
```

`active_window` is display text only. It is never persisted to the database and
never written to logs, because a window title can contain a file path or a
customer name.

### `POST /api/sessions/{session_id}/manifest`

Sent once after a graceful stop, before the session enters `review`.

```jsonc
{
  "agent_id": "uuid",
  "started_at": "2026-09-06T18:30:00Z",
  "ended_at": "2026-09-06T21:44:12Z",
  "clock_offset_ms": 3,
  "tracks": [
    {
      "track_id": "uuid", "kind": "screen", "source_ref": "HDMI-A-0",
      "codec": "h264_vaapi", "fps": 15,
      "pts_origin_ms": 0,
      "segments": [
        { "index": 0, "file": "seg-00000.mp4",
          "start_ms": 0, "end_ms": 60000, "bytes": 125829120 }
      ]
    }
  ]
}
```

This is what phase-2 editing consumes. It is written even though no editor
exists, because the timing data cannot be reconstructed from the media later.

### `POST /api/sessions/{session_id}/upload-complete`

After the agent has uploaded every object and read each one back.

```jsonc
{
  "agent_id": "uuid",
  "objects": 194,
  "bytes": 41000000000,
  "verified": true
}
```

`verified: true` means each object was confirmed present in S3 with the
expected size. The API marks the session `stored` only on that basis, never on
an upload command's exit status.

## Storage

The agent uploads to MinIO directly with its scoped credential; media never
passes through the API. Object keys:

```text
sessions/<YYYY>/<MM>/<DD>/<session-id>/manifest.json
sessions/<YYYY>/<MM>/<DD>/<session-id>/<agent-hostname>/<kind>-<source>/seg-NNNNN.<ext>
sessions/<YYYY>/<MM>/<DD>/<session-id>/<agent-hostname>/metadata/events.jsonl
```

Segment indices are zero-padded to five digits so lexical order is chronological
order — an editor can concatenate by sorted filename without parsing.

## Activity metadata

`events.jsonl`, one JSON object per line, at `sample_hz`:

```jsonc
{"ts": 1757183400.0, "display": "HDMI-A-0", "window": "nvim — screencast-recorder",
 "mouse": [1204, 830], "clicks": 2, "keys": 17, "hotkeys": ["ctrl+s"]}
```

`keys` is a **count**. `hotkeys` holds modifier combinations only. No field ever
carries a typed character. This is a constitutional boundary, not a
configuration default: there is no setting that enables character capture.

## Failure semantics

| Situation | Agent behaviour |
|---|---|
| API unreachable | Keep recording. Queue status reports. Reconcile on reconnect. Local media is authoritative. |
| `401`/`403` | Re-read the token from Vault once, retry once, then report and keep recording. |
| `5xx` or timeout | Exponential backoff to 60s. Never stop a recording because of an API error. |
| One ffmpeg process exits | Mark that track `degraded`, keep the others running, report on the next progress beat. |
| Free disk below floor | Stop gracefully so segments finalise, report `disk_below_threshold`. Never let ffmpeg die on a full disk. |
| Upload interrupted | Retry per object; skip objects already verified present. |

## Versioning

The agent sends `X-Agent-Protocol: 1`. The API rejects an unknown major version
with `426 Upgrade Required` rather than guessing. A field may be added to a
response without a version bump; removing or repurposing one requires it.
