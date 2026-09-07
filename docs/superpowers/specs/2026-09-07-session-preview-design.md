# Session Preview — Design

```yaml
id: SPEC-session-preview
status: approved
owner: speakASAP <ssfskype@gmail.com>
created: 2026-09-07
last_updated: 2026-09-07
completeness_level: complete
upstream:
  - ../../../SYSTEM.md
  - 2026-09-06-screencast-recorder-design.md
  - ../../06_architecture/AGENT_API_CONTRACT.md
```

## Purpose

Let the operator see what a stored session actually contains — the screen
video, its audio, and the activity timeline of window focus and mouse movement
— so they can answer "is this worth keeping?" and jump to a moment they
remember.

That is the whole scope. Preview authorises nothing. It is **not** a gate on
retention: raw footage is deleted on exactly two paths (an explicit operator
request to delete an unusable session, or completion of the publication chain
ending in a real YouTube link), and preview triggers neither. Nothing in this
work builds, implies, or prepares a deletion mechanism.

Preview is also the input to phase-2 AI editing: the timeline built here is
what a human will later use to check an automated edit.

## Out of scope

Editing, trimming, export, YouTube publication, raw-footage deletion. Phase 2.
No change to how the agent selects or records audio sources. No change to the
activity tracker.

## Verified facts

Every number here was measured on this host against real stored artefacts, not
estimated. Two figures in the originating prompt
(`2026-09-07-preview-prompt.md`) were optimistic and are superseded below.

**Segments are not faststart.** `ftyp@0`, `free@32`, `mdat@40`,
`moov@3198805` on a real stored segment. A browser cannot seek one without
downloading it whole.

**The proxy render works and is cheap.** 88 seconds of real 4K screen capture
plus its audio, on this host's VAAPI encoder: **2.7s wall, 1.29 MB output**,
`moov@32` (faststart confirmed).

**Corrected figures**, superseding the prompt:

| Quantity | Prompt said | Measured / extrapolated |
|---|---|---|
| Proxy, 88s | 0.6 MB | **1.29 MB** |
| Proxy, 4 hours | ~100 MB | **~211 MB** |
| Source, 4 hours | ~6 GB | **~1.6 GB** |

The prompt's 0.6 MB was measured against the Jabra source, which turned out to
be digital silence. The 1.29 MB figure is against the source that actually
carried audio.

**Range requests work.** MinIO returns `Accept-Ranges: bytes` and answers a
Range request with `206 Partial Content`. A faststart proxy plus a plain
`<video>` element gives seeking for free. Chunking is ruled out.

**A session has multiple audio tracks.** The real manifest carries 4 tracks:
1 screen + **3 audio**. Two of the three are digital silence (-91.0 dB mean and
max); only `Generic_USB_Audio ... Audio_2` carried signal (-57.2 dB mean,
-20.3 dB peak). That source is the system default (`pactl info`). The silent
tracks are **not defective** — they recorded correctly and there was no signal.
The console offered all three because the agent reported all three as available
capture sources, which is correct behaviour.

**Activity volume.** `events.jsonl` measures 721 bytes/sec, so a four-hour
session is **~10.4 MB** and ~216,000 samples at 5 Hz.

## Known defect this design works around

**The activity tracker never counts keystrokes or clicks.**
`ActivityTracker.countKey()` and `countClick()` have **no caller anywhere in
`agent/src`** — no input listener is wired to them. Every stored session
therefore reports zeroes: 439 samples in the reference session with
`keys=0, clicks=0, hotkeys=0` throughout.

Keypress and click density is **unavailable for all existing recordings**.
This is recorded as a defect in `TASKS.md`. It is not fixed here: the agent
holds the only copy of an unrepeatable recording, and a read-only preview
subsystem must not be what destabilises it.

The consequence for this design is a hard rule: **keys and clicks must never
render as a zero value, a flat line, or an empty bar.** A flat zero line tells
the operator the session was quiet when the truth is the signal was never
recorded — precisely the silent failure this project's constitution forbids.
The lane is omitted entirely, with a note pointing at the defect.

## Where the proxy renders

**Decision: on the agent.** A new `render-preview` command.

The initial instinct was to render API-side, leaving the agent untouched. The
measurement rules it out. The API pod is limited to `500m` CPU; at that limit,
rendering 88 seconds of source took **36 seconds** (0.41x realtime),
extrapolating to **~98 minutes** for a four-hour session, in a pod that also
serves the operator console. An independent reproduction under the same quota
measured 32.7s for 64s of source, extrapolating to ~123 minutes. The two
measurements differ with source content and neither is authoritative to the
minute; the conclusion is identical, and anything near two hours of continuous
rendering inside the pod that serves the console is disqualifying on its own.
On the agent's GPU the same session is **~7.4 minutes**.

Two further facts make it decisive rather than merely strong:

- **The pod has no `/dev/dri`.** VAAPI is unavailable there under any
  configuration, so API-side rendering would be software-only permanently —
  the ~98-minute figure is a floor, not a tunable.
- **`ffmpeg` is not in the runtime image.** Choosing API-side would mean adding
  ffmpeg to the image *and* mounting a GPU device into a Kubernetes pod: a
  materially larger deployment change than adding one agent command. The agent
  already has ffmpeg, the GPU, 24 cores, and the files.

The pod's 512Mi memory limit is a second hazard: ffmpeg decoding 4K has a
working set that makes OOM-kill a live risk, and an OOM-killed pod takes the
console down with it.

Note that GPU-versus-CPU is **not** what decides this. Unlimited, software
x264 matched VAAPI (2.79s vs 2.72s) because 4K *decode* dominates. What decides
it is that the agent has 24 cores and the files, and the pod has half a core
and neither.

### Containing the risk to the agent

The agent is the component that must not be destabilised. Three containments,
all mandatory:

1. **A render never contends with a recording — enforced in code, not
   documented.** A `render-preview` that arrives while `capture.isRunning()`
   is true is refused or deferred, never run concurrently. A recording is
   unrepeatable; a render is always repeatable. When they contend, the render
   loses, and that priority must be visible in the implementation rather than
   left to timing.
2. **Strictly read-only on session media.** The render reads segments and
   writes exactly one new object per audio source (`preview/proxy-<source>.mp4`).
   It has no delete path, matching the discipline already established in
   `Uploader`.
3. **Failure is inert.** A failed render reports failure and leaves everything
   untouched. The operator sees "render failed" and can retry. It cannot
   corrupt or lose footage because it never writes into the session directory.

### Source fallback: local files, then MinIO

The render reads from local files when present and **falls back to reading from
MinIO** when they are not. The agent already holds bucket credentials.

The reason this fallback exists, stated so a later reader does not delete it as
redundant: **local files may be gone by the time someone looks at a session**,
for reasons preview does not control and does not participate in. A preview
that only worked while local media happened to still be on the recording host
would fail exactly when it was most needed — on an older session, which is the
case where "what is actually in this?" is hardest to answer from memory.

The two paths have very different waits. Reading from MinIO means pulling
~1.6 GB for a four-hour session over the network before rendering begins. That
is acceptable but not free, and **the operator must be told which path is
running** — a silent thirty-times-longer render reads as a hang. See
"Progress reporting" below.

## Audio source selection

The proxy carries **one audio stream**, chosen automatically as the source with
the highest measured level, with a **manual override**.

Rejected alternatives: muxing all three streams costs little (3.0s vs 2.7s,
1.44 MB vs 1.29 MB) but browsers play only the first audio track in a `<video>`
element and expose no track switcher, so the extra streams are unreachable.
One proxy per audio track multiplies render time and presigned URLs for a case
that has never occurred.

**Selection** is one `volumedetect` pass per source (sub-second on 88s of
audio), deterministic and re-derivable.

**The override is part of this work, not a future mitigation.** "Loudest wins"
agreed with the system default here, which is a reasonable prior — but this
owner's stated purpose for the Jabra is voice commentary over a screencast, so
the case where the heuristic picks wrong (a quiet, correct microphone alongside
a louder ambient source) is the *intended* use, not an exotic edge. If the
operator picks a different source, the proxy is re-rendered for that source and
cached alongside the default one. A re-render costs ~3 seconds per 88 seconds
of input, so a wrong automatic pick costs a click rather than a misleading
preview.

**The sources panel** lists every audio source with its measured level,
including the silent ones, and states which was used and why — in those terms:
"selected automatically: highest measured level". The mechanism is visible
rather than mysterious. A source at -91.0 dB is labelled as digital silence,
not as a quiet room: it usually means the device was not the active input,
which is actionable information for the next recording. The panel must not
imply the silent tracks are defective.

## The activity timeline

Three lanes against the same time axis as the video.

**1. Window focus (primary).** Contiguous coloured segments, one per interval a
window held focus. Hover names the full window title; click seeks the video to
that point. The reference session has 6 distinct windows and 10 switches over
88 seconds — genuine navigational signal, and what an operator actually
remembers.

**2. Mouse activity (secondary).** Per-bucket movement magnitude, summed
|Δx|+|Δy| between consecutive samples, drawn as a density strip. Sparse but
real — 52 of 438 samples show movement — and the sparseness is itself
informative: it distinguishes reading from working.

**3. Keys and clicks — omitted.** Not drawn at all. In its place, one note:
*"Keystroke and click density not captured — see defect in TASKS.md."* When the
agent is fixed the lane appears with real data, and the meaning of its absence
was never ambiguous.

### Grouping by full title, not by application

**Decision: colour by full window title**, with a bounded palette — the top 8
titles by total focus time get their own colour, the long tail collapses into
one neutral "other", and hover gives the full title regardless of colour.

Application-grouping was considered and **rejected on the evidence**, recorded
here so it is not re-proposed. Four of six real titles end in ` - Google Chrome`
and one in ` - Cursor`, so a trailing-delimiter heuristic works for five. But
one title has **no delimiter at all** (`✳ Multi-screen recording system with
web interface`) and it is the **second most active window**, 81 of 439 samples.
Application-grouping would file it under "(unknown)" while collapsing four
Chrome tabs — four genuinely different work contexts — into one indistinguishable
band. That inverts the signal: it hides the distinctions the operator remembers
and highlights one they do not.

The bounded palette degrades in the right direction: the windows with the most
focus time stay distinguishable, and briefly-touched windows become visually
quiet, which is honest, because they were.

### Bucketing

**Fixed bucket count, not fixed duration** — roughly one bucket per horizontal
pixel (~1000). For 88 seconds that is sub-sample resolution; for four hours it
is ~14s per bucket. This is what keeps a three-hour session drawable.

**Bucketing happens server-side.** At 10.4 MB and ~216,000 samples for four
hours, the raw stream is not something a browser should parse; ~1000 buckets is
tens of KB and trivial. The API streams and parses `events.jsonl` from MinIO —
a text file, small enough to handle in the pod without the memory concerns that
disqualified video rendering there.

### Window titles are load-bearing for display

Window titles are the primary navigational signal **and** the one field in the
activity stream that can carry sensitive text. The real session captured
project names and at least one string that reads as a client or organisation.

`ActivityTracker.sanitiseWindowTitle` already redacts seven credential patterns
and truncates to 200 characters. That is upstream of preview and is **not**
changed here. But preview is the first thing that puts those titles on a
screen, so the sanitiser is now **load-bearing for display**, not only for
storage: a future change to it has a blast radius it did not previously have.

That dependency is recorded here **and pinned by a test**: a title carrying a
credential-shaped string must not survive into what the timeline endpoint
returns. Not because preview adds redaction — it correctly does not — but
because the guarantee currently rests on a component two layers away with
nothing asserting the contract between them. A test at the boundary is what
makes "load-bearing" true rather than aspirational.

This project has already had a silent failure of exactly that shape: counters
tested in isolation, wired to nothing, reported as working because their output
had the right shape. A sanitiser assumed to run upstream is the same trap with
worse consequences.

## Render lifecycle

State on a new `session_preview` row, one per session per audio source:

```text
pending → rendering → ready | failed
```

The operator opens preview. If no proxy exists for the chosen source, the API
queues a `render-preview` command and returns `rendering`.

**The timeline is never gated on the render, deliberately.** It comes from
`events.jsonl`, which needs no rendering, so it is shown immediately while the
video area reports progress. Making the operator wait ~7 minutes to see which
windows they were in would be an artificial delay. An operator can answer "what
was I doing at 14:20" before a single frame renders.

**Progress reporting distinguishes the two source paths**, using the existing
progress-report channel — no new transport:

- local: *"Rendering from local files — about 7 minutes"*
- MinIO: *"Fetching 1.6 GB from storage, then rendering — about 20 minutes"*

**Failure** is explicit: state `failed` with a reason, a retry control, and
nothing deleted.

## Placement and routes

**A new screen**, reached from a row in the sessions list — not a panel on the
list. The list is a polling table; preview needs a video element, a timeline,
and a sources panel, and it needs a **stable URL** so a specific session's
preview can be returned to directly. It follows the existing `show(...)` screen
pattern in `public/app.js`, so it costs no new frontend machinery.

All preview routes are the **operator lane**: no `@AgentRoute()`, no
`@Public()`. The global `UserAuthGuard` covers them.

| Route | Purpose |
|---|---|
| `GET /api/sessions/:id/preview` | status; audio sources with measured levels; which was selected and why |
| `POST /api/sessions/:id/preview` | request a render for a chosen source |
| `GET /api/sessions/:id/preview/media` | presigned GET, short expiry, redirect |
| `GET /api/sessions/:id/timeline` | bucketed activity JSON |

The agent-lane addition is the `render-preview` command type, delivered through
the existing long-poll channel. No change to the agent's authentication or to
`AGENT_API_CONTRACT.md`'s transport rules.

## Storage boundary

Unchanged, and must stay so. No public bucket policy, no root credential, no
widening of the scoped policy beyond `screencast-sessions`.

Presigned GETs need **no new permission**: `s3:GetObject` is already granted,
which is exactly what presigning uses.

**CORS.** `screencast-sessions` has no CORS configuration. A plain
`<video src>` without the `crossorigin` attribute does not require CORS, so
this is expected to work as-is — but it is **verified empirically as a plan
step rather than assumed**. If bucket CORS configuration turns out to be
genuinely required, that is raised and stopped on, not configured.

## Error handling

Consistent with the project rule that "not found" and "lookup failed" stay
distinguishable:

- A session that is not `stored` has no preview; that is a distinct answer, not
  an error.
- A missing proxy object is `pending`, not a failure.
- A render that fails records its reason and is retryable.
- An unreadable `events.jsonl` is reported as such; the timeline is never
  silently rendered empty, for the same reason keys and clicks are never
  rendered as zero.

## Testing

- Bucketing: fixed bucket count across session lengths; uneven segment ranges
  respected (`start_ms`/`end_ms`, never `index * segment_time`).
- Focus lane: contiguous intervals; top-8 palette with "other" collapse.
- **Sanitiser boundary test**: a credential-shaped window title does not
  survive into the timeline endpoint's response.
- Keys/clicks are absent from the response shape entirely — asserted, so a
  future change cannot reintroduce them as zeroes.
- Audio selection: highest measured level wins; override re-renders and caches
  per source.
- Contention: a render requested while capture is running is refused or
  deferred, never concurrent.
- Route lane: preview routes carry neither `@AgentRoute()` nor `@Public()`.
