import { hostname } from 'node:os';
import { readFile, mkdir } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { Agent, Command } from './agent';
import { ApiClient } from './api-client';
import { discoverCapabilities } from './capabilities';
import { buildProbeArgs, isNoSignal } from './capture/camera-probe';
import { LivePreviewServer } from './capture/preview-server';
import { PullerSupervisor } from './capture/puller';

/**
 * Port for the live camera preview, on the loopback interface only.
 *
 * Fixed rather than negotiated: the console builds the URL, and the operator
 * browses from this same host, so there is nothing to discover.
 */
const LIVE_PREVIEW_PORT = 3392;
import { CaptureSession, TrackRequest } from './capture/session';
import { checkClock } from './clock';
import { loadConfig } from './config';
import { httpClient, loadCredentials } from './vault';
import { Uploader, s3Client } from './upload/uploader';
import {
  cleanWorkDir,
  fileBytes,
  localTrackSegments,
  PreviewRenderer,
  probeDurationMs,
  runFfmpeg,
  runFfmpegBinary,
} from './preview/renderer';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Entry point for the host recording agent.
 *
 * Runs as a systemd *user* service, because capture needs this login session's
 * X11 socket, PipeWire socket and /dev/dri. A system unit has none of them.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  await mkdir(config.recordingDir, { recursive: true });

  const vault = httpClient(config.vaultAddr);
  let credentials = await loadCredentials(vault, {
    roleId: config.roleId,
    secretId: config.secretId,
  });

  const api = new ApiClient(config.apiUrl, credentials.agentBearer);

  const machineId = (await readFile('/etc/machine-id', 'utf8')).trim();
  const { agent_id: agentId, poll_interval_seconds: pollSeconds } = await api.enroll({
    hostname: hostname(),
    machine_id: machineId,
    platform: process.platform === 'darwin' ? 'darwin' : 'linux',
    agent_version: config.version,
  });

  console.log(`enrolled as ${agentId}`);

  // Reported at every startup: hardware changes between runs, and the operator
  // must never be offered a monitor that has since been unplugged.
  let capabilities = await discoverCapabilities(config.recordingDir);
  await api.reportCapabilities(agentId, capabilities);

  // One puller and one preview server for the life of the agent. Both are
  // idle until the operator asks for them from the console.
  const puller = new PullerSupervisor();
  const livePreview = new LivePreviewServer(config.cameraDevice, LIVE_PREVIEW_PORT);

  let session: CaptureSession | null = null;
  let activeSessionId: string | null = null;

  const agent = new Agent(
    {
      api: {
        post: (path, body) => api.post(path, body),
        nextCommand: (id) => api.nextCommand(id),
      },
      capture: {
        /**
         * Reads one frame to prove the camera is delivering, not merely present.
         *
         * A failure here is not a crash: "no signal" is an answer the operator
         * acts on -- start the phone app, or the puller -- so it is reported
         * rather than thrown.
         */
        async probeCamera(device) {
          try {
            await runFfmpeg(buildProbeArgs(device));
            return { hasSignal: true, detail: 'frames arriving' };
          } catch (error) {
            const message = (error as Error).message;
            return {
              hasSignal: false,
              detail: isNoSignal(message) ? 'no signal from the camera' : message.slice(0, 200),
            };
          }
        },
        /**
         * Starts, stops or reports the puller.
         *
         * Owned by the agent rather than a systemd unit because its lifetime is
         * the operator's: it runs while they are setting up and recording, and
         * there is no reason for it to survive the agent that drives it.
         */
        async puller(action) {
          if (action === 'start') {
            if (!config.cameraUrl) {
              return { running: false, error: 'no cameraUrl in the agent config' };
            }
            puller.start({ sourceUrl: config.cameraUrl, device: config.cameraDevice });
            livePreview.start();
          } else if (action === 'stop') {
            puller.stop();
            livePreview.stop();
          }
          return { ...puller.status(), previewPort: LIVE_PREVIEW_PORT };
        },
        async start(sessionId, tracks) {
          activeSessionId = sessionId;
          capabilities = await discoverCapabilities(config.recordingDir);
          session = new CaptureSession({
            sessionId,
            hostname: hostname(),
            display: process.env.DISPLAY ?? ':0.0',
            rootDir: config.recordingDir,
            displays: capabilities.displays,
          });
          const clock = await checkClock();
          await session.start(tracks as TrackRequest[], clock.offset_ms);
        },
        async stop() {
          const active = session;
          if (!active) return;

          const sessionId = activeSessionId;
          const manifest = await active.stop(agentId);

          // Posted after the graceful stop so the API holds the timing contract
          // before the operator is asked to save. A failure here does not lose
          // the manifest: session.stop() has already written it beside the
          // media, and the agent retries on reconnect.
          if (sessionId) {
            await api
              .post(`/api/sessions/${sessionId}/manifest`, manifest)
              .catch((error) =>
                console.error('manifest post failed, kept locally:', (error as Error).message),
              );
          }
          session = null;
        },
        /**
         * Uploads every file of a stopped session, then reads them all back.
         *
         * Walks the session directory rather than the manifest, so the
         * activity stream and the manifest itself travel too -- the manifest
         * lists media segments only, and a session missing its own timing
         * contract is not much use to a later editing stage.
         */
        async upload(sessionId, prefix) {
          const dir = join(config.recordingDir, sessionId);
          const files: { path: string; key: string; bytes: number }[] = [];

          const walk = async (current: string, keyPrefix: string): Promise<void> => {
            for (const entry of await readdir(current, { withFileTypes: true })) {
              const path = join(current, entry.name);
              const key = `${keyPrefix}/${entry.name}`;
              if (entry.isDirectory()) await walk(path, key);
              else files.push({ path, key, bytes: (await stat(path)).size });
            }
          };
          await walk(dir, prefix);

          const uploader = new Uploader(
            s3Client({
              endpoint: credentials.minio.endpoint,
              accessKeyId: credentials.minio.accessKeyId,
              secretAccessKey: credentials.minio.secretAccessKey,
              bucket: credentials.minio.bucket,
            }),
            credentials.minio.bucket,
          );

          const result = await uploader.uploadAll(files);
          console.log(
            `uploaded ${result.objects} objects (${result.bytes} bytes), verified=${result.verified}`,
          );
          return { objects: result.objects, bytes: result.bytes, verified: result.verified };
        },
        /**
         * Renders the preview set for a stored session.
         *
         * Runs here rather than in the API pod, which has no /dev/dri, no
         * ffmpeg and 500m of CPU. Strictly additive on storage: it writes new
         * objects under `<prefix>/preview/` and deletes nothing anywhere. Its
         * only scratch space is a temporary directory it creates and removes
         * itself, never the session directory.
         */
        async renderPreview(sessionId, prefix, audioSourceRefs) {
          const host = hostname();
          const s3 = s3Client({
            endpoint: credentials.minio.endpoint,
            accessKeyId: credentials.minio.accessKeyId,
            secretAccessKey: credentials.minio.secretAccessKey,
            bucket: credentials.minio.bucket,
          });
          const uploader = new Uploader(s3, credentials.minio.bucket);
          const workDir = join(config.recordingDir, '.preview-work', sessionId);

          // The screen track directory is discovered rather than assumed: the
          // display name is part of it and varies by host.
          const sessionDir = join(config.recordingDir, sessionId, host);
          let screenTrackDir = 'screen';
          try {
            const found = (await readdir(sessionDir)).find((name) => name.startsWith('screen-'));
            if (found) screenTrackDir = found;
          } catch {
            // Local media is gone; the storage path resolves the name below.
          }
          if (screenTrackDir === 'screen') {
            const keys = await s3.list(`${prefix}/${host}/`);
            const match = keys.find((key) => key.includes('/screen-'));
            if (match) screenTrackDir = match.split(`${prefix}/${host}/`)[1].split('/')[0];
          }

          const renderer = new PreviewRenderer({
            run: (args) => runFfmpeg(args),
            runBinary: (args) => runFfmpegBinary(args),
            localSegments: (id, trackDir) =>
              localTrackSegments(config.recordingDir, id, host, trackDir),
            async fetchSegments(objectPrefix, trackDir, into) {
              const keys = await s3.list(`${objectPrefix}/${host}/${trackDir}/`);
              const paths: string[] = [];
              for (const key of keys) {
                const name = key.split('/').pop();
                if (!name || !name.startsWith('seg-')) continue;
                const to = join(into, name);
                await s3.get(key, to);
                paths.push(to);
              }
              return paths;
            },
            async upload(path, key) {
              const bytes = await fileBytes(path);
              await uploader.uploadFile(path, key, bytes);
              return bytes;
            },
            durationMs: probeDurationMs,
            workDir,
            onProgress: (message) => console.log(`preview ${sessionId}: ${message}`),
          });

          try {
            return await renderer.render(sessionId, prefix, audioSourceRefs, screenTrackDir);
          } finally {
            // Removes only the renderer's own scratch directory. Session media
            // is never touched by anything in this path.
            await cleanWorkDir(workDir);
          }
        },
        isRunning: () => session?.isRunning() ?? false,
        states: () => session?.states() ?? [],
        currentWindow: () => session?.currentWindow() ?? null,
      },
      clock: { check: checkClock },
      disk: {
        async freeBytes() {
          const fs = await statfs(config.recordingDir);
          return Number(fs.bavail) * Number(fs.bsize);
        },
      },
      async reloadCredentials() {
        credentials = await loadCredentials(vault, {
          roleId: config.roleId,
          secretId: config.secretId,
        });
        api.setBearer(credentials.agentBearer);
      },
    },
    { agentId, minFreeGb: config.minFreeGb },
  );

  // Two independent loops. Polling must not be delayed by a slow progress
  // report, and a progress report must not be skipped because a poll is parked
  // in its 25-second window.
  void pollLoop(api, agent, agentId, pollSeconds);
  void tickLoop(agent);

  console.log('agent running');
}

async function pollLoop(
  api: ApiClient,
  agent: Agent,
  agentId: string,
  pollSeconds: number,
): Promise<void> {
  let backoffMs = 0;

  for (;;) {
    try {
      const command: Command | null = await api.nextCommand(agentId);
      backoffMs = 0;
      if (command) await agent.handle(command);
    } catch {
      // Never stop polling and never touch capture: the recording outlives the
      // controller. Back off to a minute so a long outage is not a hot loop.
      backoffMs = Math.min(60_000, backoffMs === 0 ? 1000 : backoffMs * 2);
      await sleep(backoffMs);
    }

    if (backoffMs === 0) await sleep(pollSeconds * 100);
  }
}

async function tickLoop(agent: Agent): Promise<void> {
  for (;;) {
    try {
      await agent.tick();
    } catch (error) {
      // A failed tick is never allowed to end the loop; that would silently
      // stop progress reporting for the rest of the session.
      console.error('tick failed:', (error as Error).message);
    }
    await sleep(5000);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

main().catch((error) => {
  // Exit non-zero so systemd restarts, and say why: a silently dead agent looks
  // identical to an idle one.
  console.error('agent failed to start:', (error as Error).message);
  process.exit(1);
});
