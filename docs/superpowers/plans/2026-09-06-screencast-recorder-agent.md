# Screencast Recorder — Host Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the host-bound recording agent: it discovers what the machine can actually capture, reads its credentials from Vault by AppRole, waits on a clock barrier, records each source as an independent segmented track under VAAPI, writes a privacy-safe activity stream, and uploads a saved session to MinIO with per-object readback.

**Architecture:** A single Node process run as a **systemd user service**, because it needs the X11 socket, the PipeWire socket and `/dev/dri` — all of which belong to the logged-in graphical session and none of which a pod can reach. It owns no durable state beyond a local session directory and a small JSON state file. It polls the API for commands and never listens on a port. Local media is authoritative until a session is stored.

**Tech Stack:** Node 22, TypeScript, `ffmpeg` 6.1 with `h264_vaapi`, `xdotool`, `chrony`, `@aws-sdk/client-s3`, `node-vault` (or plain HTTPS against Vault), Jest.

**Spec:** `docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`
**Contract:** `docs/06_architecture/AGENT_API_CONTRACT.md`

## Global Constraints

- Runs as `systemctl --user`, never as a system unit and never as root. A system unit has no access to the user's X11 display or PipeWire socket.
- Verified host facts: X11 with `DISPLAY=:0`; one display `HDMI-A-0` at 3840x2160; AMD Navi 33, so **`h264_vaapi` via `/dev/dri/renderD128`** — the NVENC encoders ffmpeg lists have no matching hardware; **no camera** (`/dev/video*` absent); microphone `Jabra Link 390` through PipeWire.
- On this host `mc` is **GNU Midnight Commander**, and there is no `aws`, `mcli`, `rclone` or `boto3`. Uploads use the Node AWS SDK. Never shell out to `mc`.
- Credentials come from Vault by AppRole (`role_id` in config, response-wrapped `secret_id` at enrollment). Never a static token file, never a self-signed token.
- **Never record keystroke content.** Counts and modifier names only. There is no configuration flag that changes this.
- Stop with `SIGINT`, never `SIGKILL` — `SIGKILL` leaves an unfinalized MP4 and loses the last segment.
- Never delete local media that has not been uploaded, verified, and previewed by the operator. Phase 1 deletes nothing automatically.
- Keep recording through an API outage. The API is a controller, not a dependency.

---

### Task 1: Capability discovery

**Files:**
- Create: `agent/package.json`, `agent/tsconfig.json`, `agent/jest.config.js`
- Create: `agent/src/capabilities.ts`
- Test: `agent/src/capabilities.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `discoverCapabilities(): Promise<Capabilities>` matching the contract's capabilities payload

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/capabilities.spec.ts
import { parseDisplays, parseAudioInputs, parseEncoders, pickScreenEncoder } from './capabilities';

describe('capability parsing', () => {
  it('parses xrandr --listmonitors', () => {
    const out = 'Monitors: 1\n 0: +*HDMI-A-0 3840/600x2160/340+0+0  HDMI-A-0\n';
    expect(parseDisplays(out)).toEqual([
      { id: 'HDMI-A-0', width: 3840, height: 2160, x: 0, y: 0, primary: true },
    ]);
  });

  it('returns an empty camera list without throwing when /dev/video* is absent', () => {
    // The verified state of this host. An absent camera is a capability that is
    // missing, not a failure to discover.
    expect(parseDisplays('Monitors: 0\n')).toEqual([]);
  });

  it('keeps only real audio sources, dropping monitors', () => {
    const out = [
      '51\talsa_output.usb-Jabra.monitor\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED',
      '52\talsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback\tPipeWire\ts16le 1ch 16000Hz\tSUSPENDED',
    ].join('\n');
    const inputs = parseAudioInputs(out);
    // A ".monitor" source is loopback of an output, not a microphone.
    expect(inputs.map((i) => i.id)).toEqual([
      'alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback',
    ]);
  });

  it('prefers VAAPI over software encoding when present', () => {
    expect(pickScreenEncoder(['libx264', 'h264_vaapi'])).toBe('h264_vaapi');
  });

  it('never picks NVENC on a machine with no NVIDIA device', () => {
    // ffmpeg lists h264_nvenc on this host, but the GPU is an AMD Navi 33.
    // Selecting it produces a runtime failure several minutes into a session.
    expect(pickScreenEncoder(['h264_nvenc', 'libx264'], { hasNvidia: false })).toBe('libx264');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent && npx jest src/capabilities --no-coverage`
Expected: FAIL — cannot find module `./capabilities`.

- [ ] **Step 3: Implement**

`discoverCapabilities` shells out to `xrandr --listmonitors`, `pactl list short sources`, `ffmpeg -hide_banner -encoders`, `ls /dev/video*` (empty is normal), `df` for free bytes, and `chronyc tracking` for clock state. Encoder selection cross-checks `lspci` for a vendor match rather than trusting ffmpeg's compiled-in list.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/capabilities --no-coverage`
Expected: PASS.

- [ ] **Step 5: Run it against the real host**

```bash
cd agent && npx ts-node -e "import('./src/capabilities').then(m => m.discoverCapabilities().then(c => console.log(JSON.stringify(c, null, 2))))"
```

Expected: one display `HDMI-A-0` 3840x2160; the Jabra input present; `cameras: []`; `h264_vaapi` among encoders; `session_type: "x11"`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(agent): capability discovery from the live host"
```

---

### Task 2: Vault AppRole credential loading

**Files:**
- Create: `agent/src/vault.ts`, `agent/src/config.ts`
- Test: `agent/src/vault.spec.ts`

**Interfaces:**
- Consumes: AppRole `screencast-agent`, `role_id` from config, `secret_id` from local state
- Produces: `loadCredentials(): Promise<{ agentBearer, minio: {...} }>`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/vault.spec.ts
import { unwrapSecretId, loadCredentials } from './vault';

describe('vault approle', () => {
  it('unwraps a wrapping token exactly once and keeps the secret_id', async () => {
    const http = { post: jest.fn().mockResolvedValue({ data: { secret_id: 's3cr3t' } }) };
    expect(await unwrapSecretId(http as never, 'wrap-token')).toBe('s3cr3t');
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('never puts a credential into an error message', async () => {
    const http = {
      post: jest.fn().mockResolvedValue({ auth: { client_token: 'vault-token' } }),
      get: jest.fn().mockRejectedValue(new Error('permission denied')),
    };
    await expect(loadCredentials(http as never, { roleId: 'r', secretId: 'SUPERSECRET' }))
      .rejects.toThrow(expect.not.stringContaining?.('SUPERSECRET') ?? Error);
    const serialised = JSON.stringify(http.post.mock.calls);
    expect(serialised).toContain('SUPERSECRET');      // sent to Vault, as required
    // but the thrown error must not carry it
    await loadCredentials(http as never, { roleId: 'r', secretId: 'SUPERSECRET' })
      .catch((e: Error) => expect(e.message).not.toContain('SUPERSECRET'));
  });

  it('refuses to start when AGENT_BEARER is absent', async () => {
    // Better to fail loudly at startup than to record for three hours and
    // discover at upload time that nothing can authenticate.
    const http = {
      post: jest.fn().mockResolvedValue({ auth: { client_token: 't' } }),
      get: jest.fn().mockResolvedValue({ data: { data: { MINIO_BUCKET: 'b' } } }),
    };
    await expect(loadCredentials(http as never, { roleId: 'r', secretId: 's' }))
      .rejects.toThrow(/AGENT_BEARER/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/vault --no-coverage`
Expected: FAIL — cannot find module `./vault`.

- [ ] **Step 3: Implement**

`POST /v1/auth/approle/login` with `role_id` and `secret_id`, then `GET /v1/secret/data/prod/screencast-recorder` with the resulting token. Validate that every required key is present and throw naming the **missing key** — never the value. Wrap all errors so a Vault response body can never reach a log line.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/vault --no-coverage`
Expected: PASS.

- [ ] **Step 5: Prove it against the real Vault**

```bash
export VAULT_ADDR=http://127.0.0.1:8200
ROLE_ID=$(vault read -field=role_id auth/approle/role/screencast-agent/role-id)
WRAP=$(vault write -wrap-ttl=120s -f -field=wrapping_token auth/approle/role/screencast-agent/secret-id)
# agent unwraps, logs in, reads; prints key NAMES only
cd agent && npx ts-node src/bin/probe-vault.ts --role-id "$ROLE_ID" --wrap "$WRAP"
```

Expected: the 13 key names, no values.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(agent): Vault AppRole credential loading"
```

---

### Task 3: The clock barrier and T0 scheduling

**Files:**
- Create: `agent/src/clock.ts`
- Test: `agent/src/clock.spec.ts`

**Interfaces:**
- Consumes: `chronyc tracking`
- Produces: `checkClock(): Promise<{ synchronised, offsetMs, source }>`; `waitUntil(t0: Date): Promise<void>`; `T0_TOLERANCE_MS`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/clock.spec.ts
import { parseChronyTracking, msUntil, t0Missed, T0_TOLERANCE_MS } from './clock';

describe('clock barrier', () => {
  it('parses chronyc tracking into an offset in milliseconds', () => {
    const out = [
      'Reference ID    : C0A80001 (ntp.example)',
      'Stratum         : 3',
      'System time     : 0.000003204 seconds slow of NTP time',
      'Leap status     : Normal',
    ].join('\n');
    const r = parseChronyTracking(out);
    expect(r.synchronised).toBe(true);
    expect(Math.abs(r.offsetMs)).toBeLessThan(1);
  });

  it('treats an unsynchronised leap status as not ready', () => {
    // Starting unsynchronised silently misaligns every track in the session.
    const out = 'System time : 0.1 seconds slow of NTP time\nLeap status     : Not synchronised';
    expect(parseChronyTracking(out).synchronised).toBe(false);
  });

  it('reports t0_missed rather than starting late', () => {
    const past = new Date(Date.now() - T0_TOLERANCE_MS - 1000);
    expect(t0Missed(past)).toBe(true);
    // Within tolerance is fine: the command may have taken a moment to arrive.
    expect(t0Missed(new Date(Date.now() - 100))).toBe(false);
  });

  it('computes a positive wait for a future t0', () => {
    expect(msUntil(new Date(Date.now() + 5000))).toBeGreaterThan(4000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/clock --no-coverage`
Expected: FAIL — cannot find module `./clock`.

- [ ] **Step 3: Implement**

Parse `chronyc tracking`. `synchronised` requires `Leap status: Normal` **and** an absolute offset under a threshold. `waitUntil` sleeps in a coarse loop then busy-waits the final 50ms, so the start instant is tight without burning CPU for seconds.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/clock --no-coverage`
Expected: PASS.

- [ ] **Step 5: Check against the real chrony**

```bash
chronyc tracking | head -5
cd agent && npx ts-node -e "import('./src/clock').then(m => m.checkClock().then(console.log))"
```

Expected: `synchronised: true` with a small offset on this host.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(agent): chrony-based clock barrier and T0 scheduling"
```

---

### Task 4: ffmpeg supervision with VAAPI and segmentation

**Files:**
- Create: `agent/src/capture/ffmpeg.ts`, `agent/src/capture/supervisor.ts`
- Test: `agent/src/capture/ffmpeg.spec.ts`, `supervisor.spec.ts`

**Interfaces:**
- Consumes: track specs from the `prepare` payload
- Produces: `buildScreenArgs(spec)`, `buildAudioArgs(spec)`, `CaptureSupervisor` with `start`, `stop`, `on('exit')`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/capture/ffmpeg.spec.ts
import { buildScreenArgs, buildAudioArgs } from './ffmpeg';

describe('ffmpeg argument construction', () => {
  const spec = {
    source_ref: 'HDMI-A-0', width: 3840, height: 2160, fps: 15,
    codec: 'h264_vaapi', segment_seconds: 60, outDir: '/tmp/s/screen',
  };

  it('segments output rather than writing one long file', () => {
    const a = buildScreenArgs(spec as never).join(' ');
    // Segmentation caps crash loss at one segment and lets an editor drop
    // whole intervals with -c copy.
    expect(a).toContain('-f segment');
    expect(a).toContain('-segment_time 60');
    expect(a).toContain('seg-%05d.mp4');
  });

  it('zero-pads segment indices to five digits', () => {
    // Lexical order must equal chronological order for a 3-4 hour session.
    expect(buildScreenArgs(spec as never).join(' ')).toContain('%05d');
  });

  it('initialises the VAAPI device and uploads frames to it', () => {
    const a = buildScreenArgs(spec as never).join(' ');
    expect(a).toContain('-vaapi_device /dev/dri/renderD128');
    expect(a).toContain('hwupload');
  });

  it('captures the mouse cursor', () => {
    // A screencast without the pointer defeats the purpose.
    expect(buildScreenArgs(spec as never).join(' ')).toContain('-draw_mouse 1');
  });

  it('writes audio as its own file, never muxed into the screen track', () => {
    const a = buildAudioArgs({ source_ref: 'jabra', codec: 'aac', bitrate_kbps: 192, segment_seconds: 60, outDir: '/tmp/s/audio' } as never).join(' ');
    expect(a).toContain('-f pulse');
    expect(a).toContain('seg-%05d.m4a');
    expect(a).not.toContain('x11grab');
  });
});
```

```typescript
// agent/src/capture/supervisor.spec.ts
describe('CaptureSupervisor', () => {
  it('stops with SIGINT so the container finalises', async () => {
    const proc = { kill: jest.fn(), on: jest.fn(), pid: 1 };
    const sup = makeSupervisor(proc);
    await sup.stop();
    // SIGKILL truncates the final segment into an unplayable file.
    expect(proc.kill).toHaveBeenCalledWith('SIGINT');
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('marks one track degraded without stopping the others', async () => {
    const sup = makeSupervisorWithTracks(['screen', 'audio']);
    sup.handleExit('screen', 1);
    expect(sup.trackState('screen').degraded).toBe(true);
    expect(sup.trackState('audio').running).toBe(true);
  });

  it('escalates to SIGKILL only after a grace period', async () => {
    const proc = { kill: jest.fn(), on: jest.fn(), pid: 1 };
    const sup = makeSupervisor(proc, { graceMs: 10 });
    await sup.stop();
    await new Promise((r) => setTimeout(r, 50));
    // Last resort: a wedged ffmpeg must not block the session forever.
    expect(proc.kill).toHaveBeenLastCalledWith('SIGKILL');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest src/capture --no-coverage`
Expected: FAIL — cannot find module `./ffmpeg`.

- [ ] **Step 3: Implement**

Screen capture, matching the verified hardware:

```text
ffmpeg -f x11grab -draw_mouse 1 -framerate 15 -video_size 3840x2160 -i :0.0
       -vaapi_device /dev/dri/renderD128
       -vf 'format=nv12,hwupload'
       -c:v h264_vaapi -qp 24
       -f segment -segment_time 60 -segment_format mp4 -reset_timestamps 1
       /path/seg-%05d.mp4
```

Audio is a separate process writing `seg-%05d.m4a`. The supervisor tracks each child, emits on exit, marks that track degraded, and leaves the rest running.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/capture --no-coverage`
Expected: PASS.

- [ ] **Step 5: Record ten real seconds**

```bash
cd agent && npx ts-node src/bin/probe-capture.ts --seconds 10 --out /tmp/capture-probe
ls -la /tmp/capture-probe/screen/
ffprobe -v error -show_entries format=duration,size -of json /tmp/capture-probe/screen/seg-00000.mp4
```

Expected: several `seg-000NN.mp4` files, each playable, each roughly 60s or the final short one. A file that ffprobe cannot read means the stop path is wrong.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(agent): VAAPI screen and audio capture with segmentation"
```

---

### Task 5: Activity tracker

**Files:**
- Create: `agent/src/activity/tracker.ts`
- Test: `agent/src/activity/tracker.spec.ts`

**Interfaces:**
- Consumes: `xdotool`, X11 input counters
- Produces: `ActivityTracker` writing `events.jsonl` at `sample_hz`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/activity/tracker.spec.ts
import { buildEvent, sanitiseWindowTitle } from './tracker';

describe('activity tracker', () => {
  it('records counts, never characters', () => {
    const e = buildEvent({
      ts: 1757183400, display: 'HDMI-A-0', window: 'nvim',
      mouse: [100, 200], clicks: 2, keys: 17, hotkeys: ['ctrl+s'],
    });
    expect(e.keys).toBe(17);
    // The constitutional boundary: no field may carry typed text.
    expect(JSON.stringify(e)).not.toMatch(/"text"|"chars"|"keystrokes"/);
  });

  it('keeps only modifier combinations in hotkeys', () => {
    const e = buildEvent({ hotkeys: ['ctrl+s', 'a', 'super+tab', 'x'] } as never);
    // A bare letter is a keystroke. Only modified combinations survive.
    expect(e.hotkeys).toEqual(['ctrl+s', 'super+tab']);
  });

  it('truncates a window title and strips anything password-shaped', () => {
    expect(sanitiseWindowTitle('x'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(sanitiseWindowTitle('vault token=hvs.CAESIJ...')).not.toContain('hvs.');
  });

  it('emits one line per sample as valid JSON', () => {
    const line = JSON.stringify(buildEvent({ ts: 1, clicks: 0, keys: 0 } as never));
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toContain('\n');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/activity --no-coverage`
Expected: FAIL — cannot find module `./tracker`.

- [ ] **Step 3: Implement**

Sample at `sample_hz`: active window via `xdotool getactivewindow getwindowname`, pointer via `xdotool getmouselocation`, and click/key **counters** from the X record extension or `/dev/input` event counts. Accumulate counts between samples and reset each tick. `hotkeys` keeps only combinations containing a modifier. Append one JSON line per sample, flushing each write so a crash loses at most one line.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/activity --no-coverage`
Expected: PASS.

- [ ] **Step 5: Sample the real desktop and inspect for leakage**

```bash
cd agent && npx ts-node src/bin/probe-activity.ts --seconds 15 --out /tmp/events.jsonl
wc -l /tmp/events.jsonl
grep -ciE '"(text|chars|keystrokes)"' /tmp/events.jsonl || echo "no content fields: OK"
head -3 /tmp/events.jsonl
```

Expected: about 75 lines for 15s at 5Hz, no content fields, plausible window names and counts.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(agent): privacy-safe activity tracker"
```

---

### Task 6: Manifest writer

**Files:**
- Create: `agent/src/manifest.ts`
- Test: `agent/src/manifest.spec.ts`

**Interfaces:**
- Consumes: segment files on disk, `clockOffsetMs`, track specs
- Produces: `buildManifest(session): Manifest` matching the contract

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/manifest.spec.ts
import { buildManifest, segmentTimeRanges } from './manifest';

describe('manifest', () => {
  it('derives per-segment time ranges from actual durations, not from the nominal length', () => {
    // The last segment is short, and a dropped frame makes others uneven.
    // An editor that trusts 60s * index would drift.
    const ranges = segmentTimeRanges([
      { file: 'seg-00000.mp4', durationMs: 60000, bytes: 1 },
      { file: 'seg-00001.mp4', durationMs: 59987, bytes: 1 },
      { file: 'seg-00002.mp4', durationMs: 12345, bytes: 1 },
    ]);
    expect(ranges[1]).toEqual(expect.objectContaining({ start_ms: 60000, end_ms: 119987 }));
    expect(ranges[2]).toEqual(expect.objectContaining({ start_ms: 119987, end_ms: 132332 }));
  });

  it('records the measured clock offset', () => {
    // Without it, two machines cannot be aligned after the fact.
    const m = buildManifest({ clockOffsetMs: 3, tracks: [], startedAt: new Date(), endedAt: new Date() } as never);
    expect(m.clock_offset_ms).toBe(3);
  });

  it('orders segments lexically, matching chronological order', () => {
    const m = buildManifest(sessionWith(['seg-00010.mp4', 'seg-00002.mp4']) as never);
    expect(m.tracks[0].segments.map((s: { file: string }) => s.file))
      .toEqual(['seg-00002.mp4', 'seg-00010.mp4']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/manifest --no-coverage`
Expected: FAIL — cannot find module `./manifest`.

- [ ] **Step 3: Implement**

Probe each segment with `ffprobe` for its true duration, accumulate start/end offsets, and emit the contract's manifest shape. Sort by filename.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/manifest --no-coverage`
Expected: PASS.

- [ ] **Step 5: Build one from the Task 4 probe output**

```bash
cd agent && npx ts-node src/bin/probe-manifest.ts --dir /tmp/capture-probe | python3 -m json.tool | head -30
```

Expected: contiguous ranges whose final `end_ms` matches the recording length.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(agent): manifest writer with probed segment durations"
```

---

### Task 7: Uploader with per-object verification

**Files:**
- Create: `agent/src/upload/uploader.ts`
- Test: `agent/src/upload/uploader.spec.ts`

**Interfaces:**
- Consumes: MinIO credentials (Task 2), the manifest (Task 6)
- Produces: `uploadSession(dir, prefix): Promise<{ objects, bytes, verified }>`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/upload/uploader.spec.ts
import { Uploader } from './uploader';

describe('Uploader', () => {
  it('skips objects already present at the right size', async () => {
    // A resumed upload must not re-send 40GB.
    const s3 = { head: jest.fn().mockResolvedValue({ ContentLength: 100 }), put: jest.fn() };
    const up = new Uploader(s3 as never, 'bucket');
    await up.uploadFile('/local/a', 'p/a', 100);
    expect(s3.put).not.toHaveBeenCalled();
  });

  it('re-uploads when the remote size differs', async () => {
    const s3 = { head: jest.fn().mockResolvedValue({ ContentLength: 40 }), put: jest.fn() };
    const up = new Uploader(s3 as never, 'bucket');
    await up.uploadFile('/local/a', 'p/a', 100);
    expect(s3.put).toHaveBeenCalled();
  });

  it('reads every object back before reporting verified', async () => {
    const s3 = { head: jest.fn().mockResolvedValue({ ContentLength: 10 }), put: jest.fn() };
    const up = new Uploader(s3 as never, 'bucket');
    const r = await up.uploadSession(dirWith(['a', 'b']), 'p');
    // Verification is a readback, not the absence of an upload error.
    expect(s3.head).toHaveBeenCalledTimes(4);  // 2 pre-checks + 2 verifications
    expect(r.verified).toBe(true);
  });

  it('reports verified false when readback finds a gap', async () => {
    const s3 = {
      head: jest.fn().mockResolvedValueOnce({ ContentLength: 0 }).mockRejectedValue(new Error('404')),
      put: jest.fn(),
    };
    const up = new Uploader(s3 as never, 'bucket');
    expect((await up.uploadSession(dirWith(['a']), 'p')).verified).toBe(false);
  });

  it('never deletes local files', async () => {
    // Deletion is a separate, operator-gated action. The uploader has no
    // business removing the only copy of an unrepeatable recording.
    const rm = jest.spyOn(require('fs/promises'), 'rm');
    const s3 = { head: jest.fn().mockResolvedValue({ ContentLength: 10 }), put: jest.fn() };
    await new Uploader(s3 as never, 'bucket').uploadSession(dirWith(['a']), 'p');
    expect(rm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/upload --no-coverage`
Expected: FAIL — cannot find module `./uploader`.

- [ ] **Step 3: Implement**

For each file: `HeadObject` first and skip when size matches; otherwise `PutObject` with retry and exponential backoff. After all uploads, `HeadObject` every key again as an independent verification pass. Return counts and `verified`. The uploader contains **no** delete path.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/upload --no-coverage`
Expected: PASS.

- [ ] **Step 5: Upload the probe session to the real bucket**

```bash
cd agent && npx ts-node src/bin/probe-upload.ts --dir /tmp/capture-probe --prefix sessions/probe
kubectl exec -n statex-apps deploy/minio-microservice -- mc ls --recursive local/screencast-sessions/sessions/probe | head
```

Expected: the segments listed with non-zero sizes. Then delete the probe prefix by hand — it is test data, not a session.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(agent): resumable uploader with readback verification"
```

---

### Task 8: Command loop and resilience

**Files:**
- Create: `agent/src/agent.ts`, `agent/src/api-client.ts`, `agent/src/state.ts`
- Test: `agent/src/agent.spec.ts`

**Interfaces:**
- Consumes: everything above
- Produces: the long-poll loop implementing `prepare`, `start`, `stop`, `abort`

- [ ] **Step 1: Write the failing test**

```typescript
// agent/src/agent.spec.ts
describe('command loop', () => {
  it('ignores a redelivered command_id', async () => {
    const agent = makeAgent();
    await agent.handle({ command_id: 'c1', type: 'start', session_id: 's', payload: { t0: future() } });
    await agent.handle({ command_id: 'c1', type: 'start', session_id: 's', payload: { t0: future() } });
    // At-least-once delivery must not produce two ffmpeg trees.
    expect(agent.captureCount()).toBe(1);
  });

  it('keeps recording when the API is unreachable', async () => {
    const agent = makeRecordingAgent();
    agent.api.failAll(new Error('ECONNREFUSED'));
    await agent.tick();
    // Local media is the source of truth; the controller is not a dependency.
    expect(agent.isRecording()).toBe(true);
  });

  it('queues status reports during an outage and flushes on reconnect', async () => {
    const agent = makeRecordingAgent();
    agent.api.failAll(new Error('ECONNREFUSED'));
    await agent.tick(); await agent.tick();
    agent.api.recover();
    await agent.tick();
    expect(agent.api.postedProgress()).toBeGreaterThan(0);
  });

  it('re-reads the token once on 401, then continues recording', async () => {
    const agent = makeRecordingAgent();
    agent.api.failNextWith(401);
    await agent.tick();
    expect(agent.vault.reloadCount()).toBe(1);
    expect(agent.isRecording()).toBe(true);
  });

  it('reports t0_missed instead of starting late', async () => {
    const agent = makeAgent();
    await agent.handle({ command_id: 'c', type: 'start', session_id: 's', payload: { t0: longPast() } });
    expect(agent.lastStatus()).toMatchObject({ state: 'failed', reason: 't0_missed' });
    expect(agent.captureCount()).toBe(0);
  });

  it('stops gracefully when free disk hits the floor', async () => {
    const agent = makeRecordingAgent({ freeGb: 2, minFreeGb: 50 });
    await agent.tick();
    expect(agent.stoppedGracefully()).toBe(true);
    expect(agent.lastStatus()).toMatchObject({ reason: 'disk_below_threshold' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/agent --no-coverage`
Expected: FAIL — cannot find module `./agent`.

- [ ] **Step 3: Implement**

Long-poll `GET /api/agents/:id/commands`. Persist applied `command_id`s in the state file. On network failure, back off to 60s and **never** touch the capture processes. Queue status and progress reports in memory and flush on reconnect. Check free disk each tick and stop gracefully at the floor.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx jest --no-coverage`
Expected: the whole agent suite PASSes.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(agent): command loop resilient to controller outage"
```

---

### Task 9: systemd user unit and installer

**Files:**
- Create: `agent/systemd/screencast-agent.service`
- Create: `scripts/install-agent.sh`
- Test: manual, on this host

**Interfaces:**
- Consumes: the built agent
- Produces: `systemctl --user` service that survives logout only if lingering is enabled

- [ ] **Step 1: Write the unit**

```ini
[Unit]
Description=Screencast recording agent
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
# A *user* unit: it needs this session's X11 socket, PipeWire socket and
# /dev/dri. A system unit runs without them and cannot capture anything.
ExecStart=/usr/bin/node %h/.local/lib/screencast-agent/dist/main.js
Restart=on-failure
RestartSec=5
# Never let a restart kill an in-flight recording's finalisation.
KillSignal=SIGINT
TimeoutStopSec=90
Environment=NODE_ENV=production

[Install]
WantedBy=graphical-session.target
```

- [ ] **Step 2: Write the installer**

`scripts/install-agent.sh` builds the agent, copies `dist/` to `~/.local/lib/screencast-agent/`, writes config with the `role_id`, prompts for a response-wrapped `secret_id`, installs the unit into `~/.config/systemd/user/`, and runs `systemctl --user daemon-reload`. It refuses to run as root.

- [ ] **Step 3: Install and start it**

```bash
bash scripts/install-agent.sh
systemctl --user enable --now screencast-agent
systemctl --user status screencast-agent --no-pager
```

Expected: active (running).

- [ ] **Step 4: Confirm it enrolled**

```bash
curl -s https://screencast.alfares.cz/api/agents | python3 -m json.tool
```

Expected: `alfares` present, with `HDMI-A-0`, the Jabra input, and `cameras: []`.

- [ ] **Step 5: Check the logs for leaked secrets**

```bash
journalctl --user -u screencast-agent -n 200 --no-pager | grep -ciE 'hvs\.|secret_id|AKIA|Bearer [A-Za-z0-9._-]{20,}' || echo "no credential material in logs: OK"
```

Expected: the OK line.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(agent): systemd user unit and installer"
```

---

### Task 10: End-to-end validation

**Files:**
- Modify: `docs/12_validation/VAL-TASK-001-bootstrap-service.md`
- Modify: `TASKS.md`, `STATE.json`

**Interfaces:**
- Consumes: the whole system
- Produces: the validation evidence that closes TASK-001

- [ ] **Step 1: Record a short real session through the UI**

Open `https://screencast.alfares.cz`, select `HDMI-A-0` and the Jabra input, title it `validation-run`, Start. Work for five minutes. Stop.

Expected: the beep at both ends; the recording screen showing segment counts climbing and a live active-window readout.

- [ ] **Step 2: Kill the API mid-recording**

Start a second session and, while it records:

```bash
kubectl scale deployment/screencast-recorder -n statex-apps --replicas=0
sleep 60
kubectl scale deployment/screencast-recorder -n statex-apps --replicas=1
```

Expected: capture continues throughout; the agent reconciles when the API returns. Verify segment files kept appearing during the outage by their mtimes.

- [ ] **Step 3: Verify the privacy boundary**

```bash
grep -ciE '"(text|chars|keystrokes)"' ~/recordings/*/metadata/events.jsonl || echo "no content fields: OK"
```

Expected: the OK line.

- [ ] **Step 4: Save one session, discard the other**

Expected: the saved session reaches `stored` only after verification; the discarded one uploads nothing and removes its local files.

- [ ] **Step 5: Verify the storage boundary still holds**

```bash
kubectl exec -n statex-apps deploy/minio-microservice -- \
  sh -c 'mc ls scoped/speakasap-records >/dev/null 2>&1 && echo "FAIL" || echo "DENIED_AS_EXPECTED"'
```

Expected: `DENIED_AS_EXPECTED`.

- [ ] **Step 6: Write the validation report and commit**

Record every command with its actual output. Then update `TASKS.md` and `STATE.json`, and commit.

---

## Definition of done

- The agent enrolls, reports real capabilities, and appears in the UI with the webcam shown unavailable.
- A session starts only after the clock barrier passes, and both beeps sound.
- Screen and audio are separate, segmented, playable tracks; `ffprobe` reads every segment including the last.
- `events.jsonl` contains counts and modifier names, and no typed characters.
- `manifest.json` reconstructs the timeline from probed durations and records the clock offset.
- Killing the API mid-recording loses no footage.
- Save marks `stored` only after per-object readback; Discard uploads nothing.
- No credential material appears in the agent's logs.
- `speakasap-records` remains unreachable with the scoped credential.
