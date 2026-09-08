# Validation: session preview

Date: 2026-09-08
Deployed image: `localhost:5000/screencast-recorder:e1c3540`
Agent: reinstalled and restarted 2026-09-08 06:13 CEST, enrolled as
`f75d5a14-a691-4f23-a264-d50ba8985057`.
Suite: 293 tests across 34 suites, no skips introduced (baseline before this
work: 174 across 23).

Every claim below was produced by running the deployed system or the compiled
agent against real stored media, not by reading code or passing unit tests.

## Reference session

`7af04ef2-0aa3-4871-88f7-69339fb780b4`, prefix
`sessions/2026/09/07/7af04ef2-0aa3-4871-88f7-69339fb780b4`. Chosen because it
captured **three** audio sources, which is the case the audio redesign exists
for.

## What was verified

### The renderer, on real media

The compiled `PreviewRenderer` — the same code path the agent invokes — ran
over the session's local files:

```
PROGRESS: rendering the video proxy
PROGRESS: rendering audio for …Audio_1__source
PROGRESS: rendering audio for …Audio_2__source
PROGRESS: rendering audio for …Jabra_Link_390…mono-fallback
PROGRESS: render complete
ELAPSED_MS 5847          SOURCE_PATH local
video   -                                262734B  72600ms
audio   …Audio_1__source                  20302B  72265ms  mean=-91    max=-91
audio   …Audio_2__source                 231775B  72425ms  mean=-54.2  max=-42.3
audio   …Jabra…mono-fallback              20870B  72347ms  mean=-91    max=-91
```

All three sources rendered; none skipped. The levels separate the microphones:
one carried signal, two recorded digital silence at exactly the -91.0 dB floor.
The byte counts corroborate it — 232 KB against 20 KB — because AAC compresses
silence heavily.

An earlier run on a different session (`aec644da`, 15.2 minutes of 4K) measured
65 MB of source to a 4.4 MB proxy in 39.8s. Extrapolated to four hours: roughly
70 MB and about 10 minutes of GPU time, an order of magnitude more than the
design's original 90-second estimate. The console reports a render as work in
progress for that reason.

### Objects in MinIO

```
TOTAL_OBJECTS 14
  preview/proxy.mp4                                     262734
  preview/audio-…Audio_1__source.m4a                     20302
  preview/audio-…Audio_2__source.m4a                    231775
  preview/audio-…Jabra…mono-fallback.m4a                 20870
NON_PREVIEW_COUNT 10
```

Four new objects, all under `preview/`. The ten original objects are untouched.
The keys match what the API derives independently — the agent's `slugSource`
and the API's `audioObjectKey` were checked against all three real PipeWire
refs of this host and agree, and give each a distinct key (two of the three
differ only in `Audio_1` against `Audio_2`).

### Range and faststart, over a presigned URL

```
HEAD  200   accept-ranges: bytes   content-length: 262734
GET   206   content-range: bytes 0-51199/262734   received 51200 bytes
moov at byte 36 | mdat at byte 7712
```

The `moov` index arrives in the first kilobytes, so a browser seeks without
downloading the file. **No bucket CORS was required and none was configured;
the bucket policy was not touched.** Chunking the proxy is unnecessary — the
HTTP stack already does it.

`ffprobe` over the presigned URL reads the proxy as h264 960x540 @ 10fps,
72.600s, and the signal-carrying audio as aac 22050 Hz mono, 72.425s. The
tracks agree to within 0.2s.

### The uploaded audio is the audio that was captured

Each proxy was fetched back from MinIO over HTTP and measured:

```
…Audio_1__source     mean=-91.0  max=-91.0
…Audio_2__source     mean=-51.2  max=-39.3
…Jabra…mono-fallback mean=-91.0  max=-91.0
```

The silent sources are genuinely silent rather than broken, and the console
labels them as such rather than implying a fault.

### The contention rule

Driven against the compiled `Agent` with capture reporting itself as running:

```
WHILE RECORDING -> {"state":"deferred","reason":"capture_running"}
AFTER IT STOPS   -> "ready"
```

`renderPreview` was wired to throw if called during capture; it was not called.
A recording cannot be repeated and a render always can, so the render stands
aside and the operator is told rather than left with a request that vanished.

### Auth lanes

`/api/sessions` and `/api/sessions/:id/preview` both answer `401` without an
operator session, from inside the pod. `/health` answers 200.

### Nothing was deleted

All three local session directories intact (10, 34 and 10 files). The
renderer's scratch directory removed itself.

## Defects found by this validation

1. **The pod crash-looped on boot** (image `3fbf0b0`, 8 restarts): `AuthModule`
   exports `AgentRoleGuard` but not the `Logger` it takes as its third
   constructor argument, and Nest resolves that in the consuming module's
   context. `SessionsModule` provided it; `PreviewModule` did not. Fixed in
   `e1aa1f5` with a test that compiles the module through the real injector —
   verified to fail with the exact production message when `Logger` is removed.
   Every other spec in the subsystem constructs its classes by hand and never
   exercises the injector, which is why this class of failure has now reached
   production twice.

   The failure mode matters more than the fix: the readiness probe correctly
   kept the previous pod serving, so the deploy read as successful while the
   new code never ran.

2. **Migrations never ran at deploy.** `migrationsRun` was unset, so both
   `session_previews` migrations existed in the image and neither executed;
   the table was present only because it had been applied by hand in an
   earlier session, and `selectedSourceRef` was absent from the live database
   while the entity declared it. Applied, then fixed at the cause in `e1c3540`
   and pinned by a test.

3. **The `post-commit` hook was missing from this repository**, so no commit it
   ever made reached the deploy queue; the pod sat 13 hours behind six commits
   on `origin/main`. Restored with `install.sh --hooks` and confirmed firing.
   `AGENTS.md` claimed auto-deploy was disabled here, which was stale.

## Not yet verified

Playback in a real browser: the video and audio elements, switching source
mid-playback without the video reloading, and clicking the timeline to seek.
Every server-side precondition for these is verified above, but the browser
behaviour itself is an owner check.
