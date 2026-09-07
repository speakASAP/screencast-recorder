import type { Command } from './agent';

/** Thrown so the agent can recognise a 401 and re-read its token. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * HTTP client for the control plane.
 *
 * The agent always initiates: a workstation has no stable inbound address, and
 * capture must survive the API being unreachable, which a pushed connection
 * cannot express.
 */
export class ApiClient {
  private bearer: string;

  constructor(
    private readonly baseUrl: string,
    bearer: string,
  ) {
    this.bearer = bearer;
  }

  /** Called after the agent re-reads a rotated token from Vault. */
  setBearer(bearer: string): void {
    this.bearer = bearer;
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new ApiError(`POST ${path} failed`, response.status);
    }
    return response.status === 204 ? null : response.json();
  }

  /**
   * Long poll for the next command.
   *
   * The server holds the request open for up to 25s and answers 204 when there
   * is nothing to do, so the client timeout must exceed that or every idle poll
   * looks like a failure.
   */
  async nextCommand(agentId: string): Promise<Command | null> {
    const response = await fetch(`${this.baseUrl}/api/agents/${agentId}/commands`, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(35_000),
    });

    if (response.status === 204) return null;
    if (!response.ok) throw new ApiError('command poll failed', response.status);

    return (await response.json()) as Command;
  }

  async enroll(body: {
    hostname: string;
    machine_id: string;
    platform: string;
    agent_version: string;
  }): Promise<{ agent_id: string; poll_interval_seconds: number }> {
    return (await this.post('/api/agents/enroll', body)) as {
      agent_id: string;
      poll_interval_seconds: number;
    };
  }

  async reportCapabilities(agentId: string, capabilities: unknown): Promise<void> {
    await this.post(`/api/agents/${agentId}/capabilities`, capabilities);
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.bearer}`,
      'X-Agent-Protocol': '1',
    };
  }
}
