import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Uploader, s3Client } from '../upload/uploader';

async function main(): Promise<void> {
  const dir = process.argv.find((a) => a.startsWith('--dir='))?.split('=')[1];
  const prefix = process.argv.find((a) => a.startsWith('--prefix='))?.split('=')[1];
  if (!dir || !prefix) { console.error('usage: probe-upload --dir=<d> --prefix=<p>'); process.exit(2); }

  const s3 = s3Client({
    endpoint: process.env.MINIO_ENDPOINT_URL!,
    accessKeyId: process.env.MINIO_ACCESS_KEY!,
    secretAccessKey: process.env.MINIO_SECRET_KEY!,
    bucket: process.env.MINIO_BUCKET!,
  });

  const files: { path: string; key: string; bytes: number }[] = [];
  for (const sub of await readdir(dir)) {
    for (const name of await readdir(join(dir, sub))) {
      const path = join(dir, sub, name);
      files.push({ path, key: `${prefix}/${sub}/${name}`, bytes: (await stat(path)).size });
    }
  }

  const uploader = new Uploader(s3, process.env.MINIO_BUCKET!);
  console.log(`uploading ${files.length} objects ...`);
  const first = await uploader.uploadAll(files);
  console.log('first pass :', JSON.stringify(first));

  // Second pass proves resumability: nothing should be re-sent.
  const before = Date.now();
  const second = await uploader.uploadAll(files);
  console.log('second pass:', JSON.stringify(second), `in ${Date.now() - before}ms`);
}
main().catch((e) => { console.error('FAILED:', (e as Error).message); process.exit(1); });
