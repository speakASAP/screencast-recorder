import { ActivityTracker } from '../activity/tracker';

/** Samples the live desktop so the output can be inspected for leakage. */
async function main(): Promise<void> {
  const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? 15);
  const out = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? '/tmp/events.jsonl';

  const tracker = new ActivityTracker(out, 5, 'HDMI-A-0');
  tracker.start();
  console.log(`sampling ${seconds}s at 5Hz into ${out} ...`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  await tracker.stop();
  console.log('done');
}

main().catch((error) => {
  console.error('activity probe failed:', (error as Error).message);
  process.exit(1);
});
