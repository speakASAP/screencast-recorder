import { collectSegments } from '../manifest';
import { buildManifest } from '../manifest';

async function main(): Promise<void> {
  const dir = process.argv.find((a) => a.startsWith('--dir='))?.split('=')[1];
  if (!dir) { console.error('usage: probe-manifest --dir=<session dir>'); process.exit(2); }

  const screen = await collectSegments(`${dir}/screen-HDMI-A-0`, '.mp4');
  const audio = await collectSegments(`${dir}/audio-jabra`, '.m4a');

  const manifest = buildManifest({
    agentId: '11111111-1111-1111-1111-111111111111',
    hostname: 'alfares',
    startedAt: new Date(Date.now() - 8000),
    endedAt: new Date(),
    clockOffsetMs: 1,
    tracks: [
      { trackId: 't-screen', kind: 'screen', sourceRef: 'HDMI-A-0', codec: 'h264_vaapi', fps: 15, segments: screen },
      { trackId: 't-audio', kind: 'audio', sourceRef: 'jabra', codec: 'aac', fps: null, segments: audio },
    ],
  });

  console.log(JSON.stringify(manifest, null, 2));
}
main().catch((e) => { console.error('failed:', (e as Error).message); process.exit(1); });
