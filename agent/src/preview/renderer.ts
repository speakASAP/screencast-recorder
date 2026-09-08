import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RenderedArtifact } from '../agent';
import {
  buildAudioProxyArgs,
  buildConcatList,
  buildPeaksArgs,
  buildVideoProxyArgs,
  buildVolumedetectArgs,
  peaksFromPcm,
} from './render';

/**
 * Runs a preview render over a stored session.
 *
 * The dependencies are injected so the ordering rules that matter -- every
 * source rendered, a partial set failing rather than reporting ready, nothing
 * ever deleted from the session directory -- are testable without spawning
 * ffmpeg or reaching MinIO.
 */
export interface RendererDeps {
  /** Runs ffmpeg and resolves with its stderr, or rejects on a non-zero exit. */
  run(args: string[]): Promise<string>;
  /**
   * Runs ffmpeg and resolves with its stdout as bytes.
   *
   * Separate from `run` because PCM is binary: decoding it through the string
   * path would corrupt every sample that happens to be invalid UTF-8, which is
   * most of them.
   */
  runBinary(args: string[]): Promise<Buffer>;
  /** Absolute paths of one track's segments, oldest first; empty when absent. */
  localSegments(sessionId: string, trackDir: string): Promise<string[]>;
  /** Downloads a track's segments from storage; used when local media is gone. */
  fetchSegments(prefix: string, trackDir: string, into: string): Promise<string[]>;
  /** Uploads one produced file and returns its byte count. */
  upload(path: string, key: string): Promise<number>;
  /** Probed duration in milliseconds, or null when it cannot be read. */
  durationMs(path: string): Promise<number | null>;
  /** Where intermediate concat lists and outputs are written. */
  workDir: string;
  /** Progress, so a multi-source render does not look stalled. */
  onProgress?(message: string): void;
}

/** Same slugging as the API's audioObjectKey, so both agree on the key. */
export function slugSource(sourceRef: string): string {
  return sourceRef.replace(/[^A-Za-z0-9_-]+/g, '_');
}

/** Parses ffmpeg's volumedetect output. Mirrors the API's parseVolumedetect. */
export function readLevels(stderr: string): { meanDb: number; maxDb: number } {
  const read = (key: string): number | null => {
    const match = stderr.match(new RegExp(`${key}:\\s*(-?[0-9.]+) dB`));
    return match ? Number(match[1]) : null;
  };
  const meanDb = read('mean_volume');
  const maxDb = read('max_volume');
  if (meanDb === null && maxDb === null) {
    // A failed measurement is not evidence of a quiet stream. Reporting the
    // silence floor here would tell the operator a microphone was dead when
    // its level was never actually read.
    throw new Error(`volumedetect produced no levels: ${stderr.slice(-200)}`);
  }
  return { meanDb: meanDb ?? maxDb!, maxDb: maxDb ?? meanDb! };
}

/**
 * Waveform resolution.
 *
 * A lane is at most ~1200 CSS pixels wide, so more buckets than this cannot be
 * drawn; fewer would visibly step on a wide screen. Fixed rather than derived
 * from duration so every lane in a session shares one horizontal scale and the
 * same instant lines up across tracks.
 */
export const PEAK_BUCKETS = 1200;

export class PreviewRenderer {
  constructor(private readonly deps: RendererDeps) {}

  /**
   * Renders the whole preview set for one session.
   *
   * Reads from local media when it is still there and falls back to storage
   * when it is not -- older sessions are exactly the ones whose contents are
   * hardest to recall, so preview must not fail precisely on them. The two
   * paths have very different waits, which is why the path taken is reported
   * rather than inferred.
   *
   * If ANY audio source fails, the whole render fails. A partial set must
   * never be reported ready: the missing source is exactly the one the
   * operator would have needed, and silently offering the rest is the failure
   * this design exists to prevent.
   */
  async render(
    sessionId: string,
    prefix: string,
    audioSourceRefs: string[],
    screenTrackDir: string,
  ): Promise<{ artifacts: RenderedArtifact[]; sourcePath: 'local' | 'storage' }> {
    await mkdir(this.deps.workDir, { recursive: true });

    const screen = await this.resolveSegments(sessionId, prefix, screenTrackDir);
    if (screen.paths.length === 0) {
      throw new Error(`no screen segments found for session ${sessionId}`);
    }

    const artifacts: RenderedArtifact[] = [];
    this.deps.onProgress?.('rendering the video proxy');

    const videoOut = join(this.deps.workDir, 'proxy.mp4');
    const videoList = await this.writeList('video', screen.paths);
    await this.deps.run(buildVideoProxyArgs(videoList, videoOut));

    const videoKey = `${prefix}/preview/proxy.mp4`;
    artifacts.push({
      kind: 'video',
      sourceRef: null,
      objectKey: videoKey,
      bytes: await this.deps.upload(videoOut, videoKey),
      durationMs: await this.deps.durationMs(videoOut),
    });

    for (const sourceRef of audioSourceRefs) {
      this.deps.onProgress?.(`rendering audio for ${sourceRef}`);
      const slug = slugSource(sourceRef);
      const audio = await this.resolveSegments(sessionId, prefix, `audio-${sourceRef}`);
      if (audio.paths.length === 0) {
        // Failing loudly rather than skipping: a source with no segments is
        // a fact about the session the operator needs told, not a source to
        // quietly omit from the set.
        throw new Error(`no audio segments found for source ${sourceRef}`);
      }

      const list = await this.writeList(`audio-${slug}`, audio.paths);
      const levels = readLevels(await this.deps.run(buildVolumedetectArgs(list)));

      const out = join(this.deps.workDir, `audio-${slug}.m4a`);
      await this.deps.run(buildAudioProxyArgs(list, out));

      const key = `${prefix}/preview/audio-${slug}.m4a`;
      artifacts.push({
        kind: 'audio',
        sourceRef,
        objectKey: key,
        bytes: await this.deps.upload(out, key),
        durationMs: await this.deps.durationMs(out),
        meanDb: levels.meanDb,
        maxDb: levels.maxDb,
      });

      // Computed here, once, rather than in the browser on every open: a
      // four-hour proxy would otherwise be downloaded and decoded in full
      // before the console could draw a single lane.
      this.deps.onProgress?.(`extracting peaks for ${sourceRef}`);
      const pcm = await this.deps.runBinary(buildPeaksArgs(list));
      const peaksPath = join(this.deps.workDir, `peaks-${slug}.json`);
      await writeFile(peaksPath, JSON.stringify({ buckets: peaksFromPcm(pcm, PEAK_BUCKETS) }));

      const peaksKey = `${prefix}/preview/peaks-${slug}.json`;
      artifacts.push({
        kind: 'peaks',
        sourceRef,
        objectKey: peaksKey,
        bytes: await this.deps.upload(peaksPath, peaksKey),
        durationMs: null,
      });
    }

    this.deps.onProgress?.('render complete');
    return { artifacts, sourcePath: screen.path };
  }

  private async resolveSegments(
    sessionId: string,
    prefix: string,
    trackDir: string,
  ): Promise<{ paths: string[]; path: 'local' | 'storage' }> {
    const local = await this.deps.localSegments(sessionId, trackDir);
    if (local.length > 0) return { paths: local, path: 'local' };

    const into = join(this.deps.workDir, 'fetched', trackDir);
    await mkdir(into, { recursive: true });
    return { paths: await this.deps.fetchSegments(prefix, trackDir, into), path: 'storage' };
  }

  private async writeList(name: string, paths: string[]): Promise<string> {
    const listPath = join(this.deps.workDir, `${name}.txt`);
    await writeFile(listPath, buildConcatList(paths));
    return listPath;
  }
}

/**
 * Spawns ffmpeg and collects stderr.
 *
 * volumedetect reports on stderr, and a failed render must carry ffmpeg's own
 * message rather than a bare exit code -- "no such file" and "no VAAPI
 * device" need very different responses from the operator.
 */
export function runFfmpeg(args: string[], binary = 'ffmpeg'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Spawns ffmpeg and collects stdout as bytes.
 *
 * The binary twin of `runFfmpeg`, for PCM: accumulating chunks into a string
 * would corrupt every sample that is not valid UTF-8. stderr is still kept, so
 * a failure carries ffmpeg's own message rather than a bare exit code.
 */
export function runFfmpegBinary(args: string[], binary = 'ffmpeg'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** Lists one track's segment files under the local session directory. */
export async function localTrackSegments(
  recordingDir: string,
  sessionId: string,
  hostname: string,
  trackDir: string,
): Promise<string[]> {
  const dir = join(recordingDir, sessionId, hostname, trackDir);
  try {
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.startsWith('seg-'))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    // Absent is an answer here: the caller falls back to storage.
    return [];
  }
}

/** Removes only the renderer's own scratch directory, never session media. */
export async function cleanWorkDir(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}

/** Probed duration in milliseconds, or null when ffprobe cannot read it. */
export async function probeDurationMs(path: string): Promise<number | null> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        path,
      ]);
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`ffprobe ${code}`))));
    });
    const seconds = Number(out.trim());
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}

/** Byte size of a produced file. */
export async function fileBytes(path: string): Promise<number> {
  return (await stat(path)).size;
}
