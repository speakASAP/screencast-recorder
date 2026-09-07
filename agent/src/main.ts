import { hostname } from 'node:os';
import { readFile, mkdir } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { Agent, Command } from './agent';
import { ApiClient } from './api-client';
import { discoverCapabilities } from './capabilities';
import { CaptureSession, TrackRequest } from './capture/session';
import { checkClock } from './clock';
import { loadConfig } from './config';
import { httpClient, loadCredentials } from './vault';

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

  let session: CaptureSession | null = null;
  let activeSessionId: string | null = null;

  const agent = new Agent(
    {
      api: {
        post: (path, body) => api.post(path, body),
        nextCommand: (id) => api.nextCommand(id),
      },
      capture: {
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
