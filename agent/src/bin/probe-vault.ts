import { httpClient, loadCredentials, unwrapSecretId } from '../vault';

/**
 * Exercises the real enrolment path: unwrap a response-wrapped secret_id, log
 * in by AppRole, read the service's own Vault path. Prints key names and value
 * lengths only -- never a value.
 */
async function main(): Promise<void> {
  const addr = process.env.VAULT_ADDR ?? 'http://127.0.0.1:8200';
  const roleId = process.argv.find((a) => a.startsWith('--role-id='))?.split('=')[1];
  const wrap = process.argv.find((a) => a.startsWith('--wrap='))?.split('=')[1];

  if (!roleId || !wrap) {
    console.error('usage: probe-vault --role-id=<id> --wrap=<wrapping-token>');
    process.exit(2);
  }

  const http = httpClient(addr);
  const secretId = await unwrapSecretId(http, wrap);
  console.log('unwrap: ok');

  const creds = await loadCredentials(http, { roleId, secretId });
  console.log('approle login + read: ok');
  console.log('AGENT_BEARER      :', `<${creds.agentBearer.length} chars>`);
  console.log('MINIO_ENDPOINT_URL:', creds.minio.endpoint);
  console.log('MINIO_BUCKET      :', creds.minio.bucket);
  console.log('MINIO_ACCESS_KEY  :', `<${creds.minio.accessKeyId.length} chars>`);
  console.log('MINIO_SECRET_KEY  :', `<${creds.minio.secretAccessKey.length} chars>`);
}

main().catch((error) => {
  console.error('FAILED:', (error as Error).message);
  process.exit(1);
});
