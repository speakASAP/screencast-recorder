import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface SegmentFile {
  file: string;
  durationMs: number;
  bytes: number;
}

export interface SegmentRange {
  index: number;
  file: string;
  start_ms: number;
  end_ms: number;
  bytes: number;
}

export interface ManifestTrackInput {
  trackId: string;
  kind: string;
  sourceRef: string;
  codec?: string | null;
  fps?: number | null;
  segments: SegmentFile[];
}

export interface ManifestInput {
  agentId: string;
  hostname: string;
  startedAt: Date;
  endedAt: Date;
  clockOffsetMs: number;
  tracks: ManifestTrackInput[];
}

export interface Manifest {
  agent_id: string;
  hostname: string;
  started_at: string;
  ended_at: string;
  clock_offset_ms: number;
  tracks: {
    track_id: string;
    kind: string;
    source_ref: string;
    codec: string | null;
    fps: number | null;
    pts_origin_ms: number;
    segments: SegmentRange[];
  }[];
}

/**
 * Lays segments end to end using their measured durations.
 *
 * Never `index * segment_time`: the final segment is short, boundaries land on
 * keyframes rather than exact seconds, and a dropped frame shortens a segment.
 * An editor computing offsets from the nominal length would drift further with
 * every cut, and the error is invisible until the audio no longer matches.
 */
export function segmentTimeRanges(segments: SegmentFile[]): SegmentRange[] {
  const ranges: SegmentRange[] = [];
  let cursor = 0;

  segments.forEach((segment, index) => {
    ranges.push({
      index,
      file: segment.file,
      start_ms: Math.round(cursor),
      end_ms: Math.round(cursor + segment.durationMs),
      bytes: segment.bytes,
    });
    cursor += segment.durationMs;
  });

  return ranges;
}

export function buildManifest(input: ManifestInput): Manifest {
  return {
    agent_id: input.agentId,
    // The API builds S3 keys as <prefix>/<hostname>/<kind>-<source_ref>/<file>,
    // so these three fields decide which objects verification looks for.
    hostname: input.hostname,
    started_at: input.startedAt.toISOString(),
    ended_at: input.endedAt.toISOString(),
    clock_offset_ms: input.clockOffsetMs,
    tracks: input.tracks.map((track) => ({
      track_id: track.trackId,
      kind: track.kind,
      source_ref: track.sourceRef,
      codec: track.codec ?? null,
      fps: track.fps ?? null,
      pts_origin_ms: 0,
      // Sorted by filename: the zero-padded index makes lexical order
      // chronological, and discovery order from readdir does not.
      segments: segmentTimeRanges(
        [...track.segments].sort((a, b) => a.file.localeCompare(b.file)),
      ),
    })),
  };
}

/** Reads a segment's true duration from the container. */
export async function probeDurationMs(path: string): Promise<number> {
  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        path,
      ],
      { timeout: 15_000 },
    );
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
  } catch {
    // A segment ffprobe cannot read is reported as zero-length rather than
    // failing the manifest: the rest of the session is still recoverable, and
    // a zero-length entry is visibly wrong to whoever reads it.
    return 0;
  }
}

/** Collects every segment in a track directory, with real durations and sizes. */
export async function collectSegments(dir: string, extension: string): Promise<SegmentFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const files = names.filter((name) => name.startsWith('seg-') && name.endsWith(extension)).sort();

  const segments: SegmentFile[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const [durationMs, stats] = await Promise.all([probeDurationMs(path), stat(path)]);
    segments.push({ file, durationMs, bytes: stats.size });
  }

  return segments;
}
