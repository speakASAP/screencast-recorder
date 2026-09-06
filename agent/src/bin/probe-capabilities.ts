import { discoverCapabilities } from '../capabilities';

async function main(): Promise<void> {
  const caps = await discoverCapabilities(process.env.HOME ?? '/tmp');
  console.log(JSON.stringify(caps, null, 2));
}

main().catch((error) => {
  console.error('capability discovery failed:', (error as Error).message);
  process.exit(1);
});
