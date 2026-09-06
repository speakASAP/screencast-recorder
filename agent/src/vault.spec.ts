import { VaultHttp, loadCredentials, unwrapSecretId } from './vault';

describe('unwrapSecretId', () => {
  it('unwraps a wrapping token exactly once', async () => {
    // The wrapping token is single-use: a retry would fail and look like a bad
    // credential rather than a double unwrap.
    const http: VaultHttp = {
      post: jest.fn().mockResolvedValue({ data: { secret_id: 's3cr3t' } }),
      get: jest.fn(),
    };
    expect(await unwrapSecretId(http, 'wrap-token')).toBe('s3cr3t');
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when the wrapping token has already been used', async () => {
    const http: VaultHttp = {
      post: jest.fn().mockRejectedValue(new Error('wrapping token is not valid or does not exist')),
      get: jest.fn(),
    };
    await expect(unwrapSecretId(http, 'stale')).rejects.toThrow(/wrapping token/i);
  });
});

describe('loadCredentials', () => {
  const secrets = {
    AGENT_BEARER: 'jwt-value',
    MINIO_ENDPOINT_URL: 'https://minio.alfares.cz',
    MINIO_BUCKET: 'screencast-sessions',
    MINIO_ACCESS_KEY: 'ak',
    MINIO_SECRET_KEY: 'sk',
  };

  it('logs in with AppRole and returns the credentials it needs', async () => {
    const http: VaultHttp = {
      post: jest.fn().mockResolvedValue({ auth: { client_token: 'vault-token' } }),
      get: jest.fn().mockResolvedValue({ data: { data: secrets } }),
    };

    const creds = await loadCredentials(http, { roleId: 'r', secretId: 's' });
    expect(creds.agentBearer).toBe('jwt-value');
    expect(creds.minio.bucket).toBe('screencast-sessions');
  });

  it('never puts the secret_id into a thrown error', async () => {
    // An error string reaches logs and terminals; a credential in one is a leak
    // that outlives the incident.
    const http: VaultHttp = {
      post: jest.fn().mockRejectedValue(new Error('permission denied')),
      get: jest.fn(),
    };

    await expect(
      loadCredentials(http, { roleId: 'r', secretId: 'SUPERSECRETVALUE' }),
    ).rejects.toThrow();

    await loadCredentials(http, { roleId: 'r', secretId: 'SUPERSECRETVALUE' }).catch(
      (error: Error) => {
        expect(error.message).not.toContain('SUPERSECRETVALUE');
        expect(error.stack ?? '').not.toContain('SUPERSECRETVALUE');
      },
    );
  });

  it('refuses to start when AGENT_BEARER is absent, naming the key only', async () => {
    // Better to fail at startup than to record for three hours and discover at
    // upload time that nothing can authenticate.
    const { AGENT_BEARER: _omitted, ...withoutBearer } = secrets;
    const http: VaultHttp = {
      post: jest.fn().mockResolvedValue({ auth: { client_token: 't' } }),
      get: jest.fn().mockResolvedValue({ data: { data: withoutBearer } }),
    };

    await expect(loadCredentials(http, { roleId: 'r', secretId: 's' })).rejects.toThrow(
      /AGENT_BEARER/,
    );
  });

  it('names every missing key at once rather than one per restart', async () => {
    const http: VaultHttp = {
      post: jest.fn().mockResolvedValue({ auth: { client_token: 't' } }),
      get: jest.fn().mockResolvedValue({ data: { data: { AGENT_BEARER: 'x' } } }),
    };

    await expect(loadCredentials(http, { roleId: 'r', secretId: 's' })).rejects.toThrow(
      /MINIO_ACCESS_KEY.*MINIO_SECRET_KEY|MINIO_SECRET_KEY.*MINIO_ACCESS_KEY/s,
    );
  });

  it('fails when Vault returns no client token', async () => {
    const http: VaultHttp = {
      post: jest.fn().mockResolvedValue({ auth: {} }),
      get: jest.fn(),
    };
    await expect(loadCredentials(http, { roleId: 'r', secretId: 's' })).rejects.toThrow(/token/i);
  });
});
