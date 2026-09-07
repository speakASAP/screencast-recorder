# Prompt: session preview for screencast-recorder

Hand the text below to a fresh session. It carries the facts that session would
otherwise have to rediscover, and flags the traps that have already cost time
in this project.

---

## Task

Build session preview for `screencast-recorder` (`/home/ssf/Documents/Github/screencast-recorder`),
so the operator can see what a stored session actually contains before deciding
to keep, edit or delete it: the screen video, the audio, and the activity
timeline of mouse and keyboard.

Follow the repo's own process. `AGENTS.md` and `docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`
are the governing documents; `docs/06_architecture/AGENT_API_CONTRACT.md`
describes the agent lane you will not be touching. Use the superpowers
brainstorming skill before designing, and writing-plans before implementing —
this is a new subsystem, not a bounded change.

## Why it matters

Phase 1 records and stores; nothing can look at the result. The design says
local media is deleted only after the operator has **previewed** the stored
session, so preview is the gate that currently blocks the retention rule, and
it is the last unbuilt piece of the capture phase. It is also the input to
phase-2 AI editing: whatever timeline you build here is what a human will use
to check an automated edit.

## What exists already (verified, do not re-derive)

**Deployed and working.** `https://screencast.alfares.cz`, image on port 3391 in
k8s `statex-apps`, one pod. NestJS + TypeORM, tests run with `npx jest` from the
repo root and cover both `src/` (API) and `agent/` — 174 across 23 suites.

**Auth.** Hosted Auth, BFF model. Operator routes are covered by a global
`UserAuthGuard` reading an HttpOnly cookie that holds an opaque session id, not
a token — the operator's Auth token is ~4 KB and exceeds the cookie limit.
Machine routes carry `@AgentRoute()` and are checked by `AgentRoleGuard`
against a pair-specific service token. **Keep those lanes separate**: preview is
an operator feature, so its routes get neither `@AgentRoute()` nor `@Public()`.

**Storage.** Private MinIO bucket `screencast-sessions` at
`https://minio.alfares.cz`. The runtime credential is a scoped, non-root service
account that can reach that bucket and nothing else — verified denied on
`speakasap-records`. `@aws-sdk/client-s3` is already a dependency and the policy
already grants `s3:GetObject`, so presigned URLs need no new credential.

**Object layout**, exactly as stored:

```text
sessions/<YYYY>/<MM>/<DD>/<session-id>/
  manifest.json
  <hostname>/screen-<display-id>/seg-00000.mp4 …
  <hostname>/audio-<pipewire-source>/seg-00000.m4a …
  <hostname>/metadata/events.jsonl
```

**A real manifest** (abridged, from a stored session):

```jsonc
{
  "agent_id": "f75d5a14-…", "hostname": "alfares",
  "started_at": "2026-09-07T13:51:51.998Z",
  "ended_at":   "2026-09-07T13:53:20.084Z",
  "clock_offset_ms": 0,
  "tracks": [{
    "track_id": "ec4de9d9-…", "kind": "screen", "source_ref": "HDMI-A-0",
    "codec": "h264_vaapi", "fps": 15, "pts_origin_ms": 0,
    "segments": [
      { "index": 0, "file": "seg-00000.mp4", "start_ms": 0,     "end_ms": 64000, "bytes": 3208728 },
      { "index": 1, "file": "seg-00001.mp4", "start_ms": 64000, "end_ms": 87867, "bytes": 4401231 }
    ]
  }]
}
```

Segment ranges come from probed durations, not `index * segment_time`. They are
uneven on purpose — boundaries land on keyframes — so build the timeline from
`start_ms`/`end_ms` and never from the nominal segment length.

**A real activity line** from `events.jsonl`, 5 Hz, one JSON object per line:

```json
{"ts":1788789112.244,"display":"HDMI-A-0","window":"Screencast Recorder - Google Chrome","mouse":[1003,822],"clicks":0,"keys":0,"hotkeys":[]}
```

`ts` is a Unix float in seconds. `keys` and `clicks` are **counts since the last
sample**, not cumulative. `hotkeys` holds modifier combinations only.

## Constraints that will bite you

These are measured on the real artefacts, not assumed.

1. **Segments are not faststart.** `ffprobe` on a stored segment puts `mdat` at
   byte 44 and no `moov` in the first 200 KB, so a browser must download a whole
   4 MB segment before showing a frame. Either remux with
   `-movflags +faststart` when preparing a preview, or accept and design around
   the delay — but do not assume `<video src=…>` will stream.

2. **Video is 3840x2160 H.264 High.** A four-hour session is roughly 240
   segments. Handing a browser 240 sequential 4K files is not a preview.

   **Build a single low-resolution proxy per session.** This was measured on a
   real stored session, not estimated, and it collapses every playback problem
   at once — the 240 files become one, the faststart problem disappears because
   you control the muxing, and the two tracks arrive already in sync:

   ```bash
   ffmpeg -vaapi_device /dev/dri/renderD128 \
     -f concat -safe 0 -i video-segments.txt \
     -f concat -safe 0 -i audio-segments.txt \
     -vf 'scale=960:540,format=nv12,hwupload' -c:v h264_vaapi -qp 32 -r 10 \
     -c:a aac -b:a 64k -ac 1 -shortest -movflags +faststart proxy.mp4
   ```

   Measured on 88 seconds of real 4K capture plus its audio: **0.6 MB output in
   2.3 seconds** of wall time on this host's AMD VAAPI encoder. Extrapolated to
   four hours that is roughly **100 MB and 90 seconds of GPU time**, against
   ~6 GB of source. Roughly 11x smaller at the segment level, and one file
   instead of 240.

   960x540 at 10 fps is legible enough to recognise what was on screen and to
   find a moment; it is not meant to be watchable output. Render it on demand
   the first time a session is previewed, store it beside the session
   (`preview/proxy.mp4`), and reuse it. Never render on the request path
   without telling the operator it is happening — a four-hour session takes
   over a minute.

   The original 4K segments stay untouched. The proxy is an additional
   artefact, never a replacement, and phase-2 editing will still cut from the
   originals.

3. **The bucket is private and there is no public read.** Media must reach the
   browser either through a presigned GET (short expiry, generated server-side)
   or proxied by the API. Presigned is preferred — the API should not become the
   data path for video, as the design already says of upload. If you presign,
   check MinIO CORS: `scripts/set-bucket-cors.sh` exists in `minio-microservice`
   and `screencast-sessions` has not been configured.

   With a single proxy file this is one presigned URL per session rather than
   hundreds, which is another reason the proxy approach is the right one.

   **Do not chunk the proxy.** The instinct to split it so only small parts are
   fetched is right about the goal and wrong about the mechanism: the browser
   already does exactly that. Verified against this MinIO through a presigned
   URL — the object returns `Accept-Ranges: bytes`, and a `Range: bytes=0-102399`
   request answers `206 Partial Content` with `content-range:
   bytes 0-102399/3208728` and transfers exactly 102400 bytes.

   So a faststart proxy plus a plain `<video>` element gives seeking for free:
   jumping to 2h30m fetches the bytes around that point and nothing else.
   Chunking would add a manifest to maintain, a player to write, and joins to
   get wrong, in exchange for a capability the HTTP stack already provides.

   The one thing that makes this work is `-movflags +faststart`, so the `moov`
   index is at the front of the file. Without it the browser cannot seek
   without downloading everything, which is precisely the trap the raw segments
   fall into.

4. **Tracks are separate files.** Screen and audio were deliberately never
   muxed. Preview must play them together and stay in sync using
   `start_ms`/`pts_origin_ms`, or offer them separately and say so.

5. **A session may span machines.** One `manifest.json` per agent, all under the
   same session prefix, each with its own `<hostname>/` subtree. Only one host
   exists today, so this is untested — do not hardcode a single manifest.

6. **`segmentCount` is 0 for the metadata track.** It writes one continuous
   file, not segments. That is correct, not a bug.

## What to build

Design it properly rather than treating this list as a specification.

- A preview screen reachable from the sessions list.
- Playback of the screen track with its audio, positioned on one timeline.
- The activity stream visualised against that same timeline: where the mouse
  was, where clicks and keypresses clustered, which window had focus. This is
  the part that makes a three-hour session navigable — busy regions are where
  the interesting work happened, and they are what a later AI edit will key on.
- Enough for the operator to answer "is this worth keeping?" and to jump to a
  moment they remember.

## What not to build

- No editing, trimming, or export. That is phase 2 and belongs to BPCP and
  `ai-microservice`.
- No YouTube.
- Do not implement deletion of raw footage. Preview is the precondition for that
  rule, but the deletion workflow is a separate, owner-gated decision.

## Non-negotiables

- **Never weaken the storage boundary.** No public bucket policy, no root
  credential, no widening the scoped policy beyond `screencast-sessions`. If
  presigned URLs need a new permission, say so and stop rather than granting it.
- **The activity stream contains no keystroke content and must never start to.**
  Preview reads it; it does not extend it.
- **Do not delete anything.** No local media, no objects, no rows.
- **Verify against the real system.** Every bug of consequence in this project
  was found by running the deployed thing, not by reading code or passing tests:
  a session that reported "recording" while capturing nothing, an upload command
  silently ignored, a login that appeared to succeed while dropping an oversized
  cookie. Record a short session, preview it, and check what you claim.
- Commit to `main` auto-deploys. Verify by pod image and age, not by the
  deploy banner: this repo has had a crash-looping pod sit behind a healthy old
  one more than once.

## Where to start

1. Read `AGENTS.md`, then the design spec, then `TASKS.md`.
2. Record a real session on `alfares` through the console so you have artefacts
   to work against, and inspect the manifest and `events.jsonl` yourself.
3. Brainstorm the approach and get owner approval before writing code. The
   proxy question is already settled by measurement above; what is still open
   is where rendering runs (the agent has the GPU and the original files; the
   API pod has neither), how the operator is told a render is in progress, and
   how the activity timeline is drawn.

   Note that rendering on the agent means the proxy is produced where the media
   already is, with no 6 GB download — but it also means a new agent command,
   and the agent is the component that must never be destabilised, because it
   holds the only copy of a recording that cannot be repeated.
