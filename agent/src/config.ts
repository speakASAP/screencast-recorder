import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentConfigFile {
  apiUrl: string;
  vaultAddr: string;
  roleId: string;
  secretId: string;
  recordingDir: string;
  minFreeGb: number;
  version: string;
}

const CONFIG_PATH = join(homedir(), '.config', 'screencast-agent', 'config.json');

/**
 * Loads agent configuration.
 *
 * The secret_id lives here rather than in the unit file or the environment: a
 * systemd Environment= value is world-readable through `systemctl show`, and
 * this file is created 0600 by the installer.
 */
export async function loadConfig(): Promise<AgentConfigFile> {
  const raw = await readFile(process.env.SCREENCAST_AGENT_CONFIG ?? CONFIG_PATH, 'utf8').catch(
    () => {
      throw new Error(
        `no agent config at ${CONFIG_PATH}; run scripts/install-agent.sh to create it`,
      );
    },
  );

  const parsed = JSON.parse(raw) as Partial<AgentConfigFile>;

  // Name every missing field at once. One per restart turns a small mistake
  // into a sequence of restarts.
  const missing = (['apiUrl', 'roleId', 'secretId'] as const).filter((key) => !parsed[key]);
  if (missing.length > 0) {
    throw new Error(`agent config is missing: ${missing.join(', ')}`);
  }

  return {
    apiUrl: parsed.apiUrl!,
    vaultAddr: parsed.vaultAddr ?? 'http://127.0.0.1:8200',
    roleId: parsed.roleId!,
    secretId: parsed.secretId!,
    recordingDir: parsed.recordingDir ?? join(homedir(), 'recordings'),
    minFreeGb: parsed.minFreeGb ?? 20,
    version: parsed.version ?? '0.1.0',
  };
}
