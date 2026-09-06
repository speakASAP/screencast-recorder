import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAudioArgs, buildScreenArgs } from '../capture/ffmpeg';
import { CaptureSupervisor } from '../capture/supervisor';

/** Records a few real seconds so the ffmpeg command line is proven, not assumed. */
async function main(): Promise<void> {
  const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? 10);
  const out = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? '/tmp/capture-probe';

  const screenDir = join(out, 'screen-HDMI-A-0');
  const audioDir = join(out, 'audio-jabra');
  await mkdir(screenDir, { recursive: true });
  await mkdir(audioDir, { recursive: true });

  const supervisor = new CaptureSupervisor();
  supervisor.start([
    {
      trackId: 'screen',
      kind: 'screen',
      outDir: screenDir,
      args: buildScreenArgs({
        display: process.env.DISPLAY ?? ':0.0',
        width: 3840,
        height: 2160,
        fps: 15,
        codec: 'h264_vaapi',
        // Short segments so a 10s probe still produces several files.
        segmentSeconds: 3,
        outDir: screenDir,
      }),
    },
    {
      trackId: 'audio',
      kind: 'audio',
      outDir: audioDir,
      args: buildAudioArgs({
        source: 'alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback',
        codec: 'aac',
        bitrateKbps: 192,
        segmentSeconds: 3,
        outDir: audioDir,
      }),
    },
  ]);

  console.log(`recording ${seconds}s to ${out} ...`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

  await supervisor.stopAll();
  for (const state of supervisor.states()) {
    console.log(
      `${state.kind.padEnd(7)} degraded=${state.degraded} exit=${state.exitCode}` +
        (state.lastError ? ` error=${state.lastError}` : ''),
    );
  }
}

main().catch((error) => {
  console.error('capture probe failed:', (error as Error).message);
  process.exit(1);
});
