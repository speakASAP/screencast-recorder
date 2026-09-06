/**
 * Vault access for the host-side agent.
 *
 * The agent runs outside Kubernetes -- it needs the X11 socket, the PipeWire
 * socket and /dev/dri -- so it has no Secret to mount and cannot use the
 * Vault -> ExternalSecret -> Secret -> secretKeyRef path the pod uses. AppRole
 * is the ecosystem's established path for a non-pod consumer; allegro, aukro,
 * bazos, flipflop and heureka already reach Vault this way.
 *
 * This is not a second credential protocol. The agent *reads* the same
 * Auth-minted RS256 pair token the service identity standard requires. It never
 * mints one, never self-signs, and never holds a static credential file.
 */

const VAULT_PATH = 'secret/data/prod/screencast-recorder';

/** The keys the agent cannot run without. */
const REQUIRED_KEYS = [
  'AGENT_BEARER',
  'MINIO_ENDPOINT_URL',
  'MINIO_BUCKET',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
] as const;

export interface VaultHttp {
  post(path: string, body: unknown, token?: string): Promise<Record<string, any>>;
  get(path: string, token: string): Promise<Record<string, any>>;
}

export interface AppRoleLogin {
  roleId: string;
  secretId: string;
}

export interface AgentCredentials {
  agentBearer: string;
  minio: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

/**
 * Wraps an error so no credential can travel inside its message or stack.
 *
 * Vault echoes request context in some failures, and the caller passes a
 * secret_id, so the original error is deliberately not chained.
 */
function scrub(operation: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  const firstLine = reason.split('\n')[0].slice(0, 200);
  return new Error(`${operation}: ${firstLine}`);
}

export async function unwrapSecretId(http: VaultHttp, wrappingToken: string): Promise<string> {
  let response: Record<string, any>;
  try {
    response = await http.post('/v1/sys/wrapping/unwrap', {}, wrappingToken);
  } catch (error) {
    throw scrub('vault unwrap failed', error);
  }

  const secretId = response?.data?.secret_id;
  if (typeof secretId !== 'string' || secretId.length === 0) {
    throw new Error('vault unwrap returned no secret_id');
  }
  return secretId;
}

export async function loadCredentials(
  http: VaultHttp,
  login: AppRoleLogin,
): Promise<AgentCredentials> {
  let auth: Record<string, any>;
  try {
    auth = await http.post('/v1/auth/approle/login', {
      role_id: login.roleId,
      secret_id: login.secretId,
    });
  } catch (error) {
    throw scrub('vault approle login failed', error);
  }

  const token = auth?.auth?.client_token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('vault approle login returned no client token');
  }

  let read: Record<string, any>;
  try {
    read = await http.get(`/v1/${VAULT_PATH}`, token);
  } catch (error) {
    throw scrub('vault read failed', error);
  }

  const data = (read?.data?.data ?? {}) as Record<string, string>;

  // Report every missing key at once. One per restart turns a five-minute fix
  // into five restarts.
  const missing = REQUIRED_KEYS.filter((key) => !data[key]);
  if (missing.length > 0) {
    throw new Error(
      `secret/prod/screencast-recorder is missing required keys: ${missing.join(', ')}`,
    );
  }

  return {
    agentBearer: data.AGENT_BEARER,
    minio: {
      endpoint: data.MINIO_ENDPOINT_URL,
      bucket: data.MINIO_BUCKET,
      accessKeyId: data.MINIO_ACCESS_KEY,
      secretAccessKey: data.MINIO_SECRET_KEY,
    },
  };
}

/** Minimal Vault HTTP client. Kept tiny so no dependency can log a token. */
export function httpClient(addr: string): VaultHttp {
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<Record<string, any>> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['X-Vault-Token'] = token;

    const response = await fetch(`${addr}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Vault's error body can echo the request, so only the status is surfaced.
      throw new Error(`vault responded ${response.status}`);
    }
    return (await response.json()) as Record<string, any>;
  };

  return {
    post: (path, body, token) => call('POST', path, body, token),
    get: (path, token) => call('GET', path, undefined, token),
  };
}
