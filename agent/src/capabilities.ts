import { execFile } from 'node:child_process';
import { readdir, statfs } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Display {
  id: string;
  width: number;
  height: number;
  x: number;
  y: number;
  primary: boolean;
}

export interface AudioInput {
  id: string;
  label: string;
  channels: number;
}

export interface Camera {
  id: string;
  label: string;
}

export interface Capabilities {
  displays: Display[];
  audio_inputs: AudioInput[];
  cameras: Camera[];
  encoders: string[];
  session_type: string;
  free_disk_bytes: number;
  clock: { synchronised: boolean; offset_ms: number; source: string };
}

/**
 * Parses `xrandr --listmonitors`.
 *
 * The geometry field is `WIDTH/PHYSICAL_MMxHEIGHT/PHYSICAL_MM+X+Y`, so the
 * slash-separated millimetre figures must be discarded. Reading them as pixels
 * would silently configure a 600x340 capture of a 4K screen.
 */
export function parseDisplays(output: string): Display[] {
  const displays: Display[] = [];

  for (const line of output.split('\n')) {
    const match = line.match(
      /^\s*\d+:\s+([+*]*)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/,
    );
    if (!match) continue;

    const [, flags, id, width, height, x, y] = match;
    displays.push({
      id,
      width: Number(width),
      height: Number(height),
      x: Number(x),
      y: Number(y),
      // xrandr marks the primary monitor with an asterisk in the flag prefix.
      primary: flags.includes('*'),
    });
  }

  return displays;
}

/**
 * Parses `pactl list short sources`, keeping only real capture devices.
 *
 * A `.monitor` source is a loopback of an output: recording one captures what
 * the speakers are playing, not what the microphone hears.
 */
export function parseAudioInputs(output: string): AudioInput[] {
  const inputs: AudioInput[] = [];

  for (const line of output.split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 4) continue;

    const id = fields[1];
    if (!id || id.endsWith('.monitor')) continue;

    const channels = Number(fields[3]?.match(/(\d+)ch/)?.[1] ?? 1);
    inputs.push({ id, label: friendlyAudioLabel(id), channels });
  }

  return inputs;
}

/**
 * Turns `alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback` into
 * `Jabra Link 390`, because the operator picks from this list.
 */
function friendlyAudioLabel(id: string): string {
  const middle = id
    .replace(/^alsa_input\./, '')
    .replace(/^usb-/, '')
    // Trailing PipeWire profile: ".mono-fallback", ".analog-stereo".
    .replace(/\.[a-z][a-z0-9-]*$/i, '')
    // ALSA hardware suffix: ".HiFi__hw_Audio_2__source".
    .replace(/\.HiFi__hw_.*$/i, '');

  const words = middle
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    // Drop the USB serial (a long hex run) and the trailing interface number,
    // but keep a model number like "390" that the operator recognises.
    .filter((part) => !/^[0-9A-F]{8,}$/i.test(part))
    .filter((part) => !/^0\d$/.test(part));

  const label = words.join(' ').trim();
  return label.length > 0 ? label : id;
}

export function parseEncoders(output: string): string[] {
  const encoders: string[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*[VAS][.A-Z]{5}\s+(\S+)/);
    if (match) encoders.push(match[1]);
  }
  return encoders;
}

export interface GpuSupport {
  hasNvidia: boolean;
  hasVaapi: boolean;
}

/**
 * Chooses the screen encoder.
 *
 * ffmpeg advertises every encoder it was compiled with, including NVENC on a
 * machine with no NVIDIA card. Trusting that list picks an encoder that fails
 * when capture starts -- minutes into a session rather than at setup -- so the
 * choice is cross-checked against hardware actually present.
 */
export function pickScreenEncoder(available: string[], gpu: GpuSupport): string {
  if (gpu.hasVaapi && available.includes('h264_vaapi')) return 'h264_vaapi';
  if (gpu.hasNvidia && available.includes('h264_nvenc')) return 'h264_nvenc';
  if (available.includes('libx264')) return 'libx264';

  throw new Error(
    'No usable H.264 encoder: ffmpeg reports none of h264_vaapi, h264_nvenc or libx264',
  );
}

/**
 * Runs a discovery command, returning '' rather than throwing.
 *
 * A missing or slow tool is a missing capability, not a crash: this host has no
 * camera, `pactl` can take seconds when PipeWire is busy, and a Wayland seat has
 * no xrandr. The generous buffer matters because `ffmpeg -encoders` prints
 * ~13 KB and a truncated read would silently drop the encoder list.
 */
async function tryRun(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(command, args, {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // Say which tool failed. Returning '' silently is how an empty encoder list
    // reaches the operator looking like "this machine cannot encode".
    process.stderr.write(
      `capability probe: ${command} unavailable (${(error as Error).message.split('\n')[0]})\n`,
    );
    return '';
  }
}

export async function detectGpu(): Promise<GpuSupport> {
  const lspci = await tryRun('lspci', []);
  const hasNvidia = /nvidia/i.test(lspci);

  let hasVaapi = false;
  try {
    await readdir('/dev/dri');
    hasVaapi = (await readdir('/dev/dri')).some((entry) => entry.startsWith('renderD'));
  } catch {
    hasVaapi = false;
  }

  return { hasNvidia, hasVaapi };
}

export async function parseCameras(): Promise<Camera[]> {
  try {
    const entries = await readdir('/dev');
    return entries
      .filter((entry) => /^video\d+$/.test(entry))
      .map((entry) => ({ id: `/dev/${entry}`, label: entry }));
  } catch {
    return [];
  }
}

export async function detectClock(): Promise<Capabilities['clock']> {
  const { parseChronyTracking } = await import('./clock');
  return parseChronyTracking(await tryRun('chronyc', ['tracking']));
}

export async function discoverCapabilities(recordingDir: string): Promise<Capabilities> {
  const [xrandr, pactl, ffmpeg, gpu, cameras, clock] = await Promise.all([
    tryRun('xrandr', ['--listmonitors']),
    tryRun('pactl', ['list', 'short', 'sources']),
    tryRun('ffmpeg', ['-hide_banner', '-encoders']),
    detectGpu(),
    parseCameras(),
    detectClock(),
  ]);

  let freeBytes = 0;
  try {
    const fs = await statfs(recordingDir);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    freeBytes = 0;
  }

  const encoders = parseEncoders(ffmpeg);

  return {
    displays: parseDisplays(xrandr),
    audio_inputs: parseAudioInputs(pactl),
    cameras,
    // Report only encoders the hardware can actually run, so the operator is
    // never offered one that will fail at capture time.
    encoders: encoders.filter(
      (name) =>
        name === 'libx264' ||
        (name === 'h264_vaapi' && gpu.hasVaapi) ||
        (name === 'h264_nvenc' && gpu.hasNvidia),
    ),
    session_type: process.env.XDG_SESSION_TYPE ?? 'unknown',
    free_disk_bytes: freeBytes,
    clock,
  };
}
