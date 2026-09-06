import { join } from 'node:path';

export interface ScreenSpec {
  display: string;
  width: number;
  height: number;
  /** Display offset within the X screen; a second monitor is not at 0,0. */
  x?: number;
  y?: number;
  fps: number;
  codec: string;
  segmentSeconds: number;
  outDir: string;
}

export interface AudioSpec {
  source: string;
  codec: string;
  bitrateKbps: number;
  segmentSeconds: number;
  outDir: string;
}

/** Constant-quality target for VAAPI. Lower is better quality and bigger. */
const VAAPI_QP = '24';
/** Equivalent for software encoding. */
const X264_CRF = '23';

/**
 * Builds the screen capture command.
 *
 * Segmented output is the load-bearing decision: it caps crash loss at one
 * segment, and it lets a later editing stage discard whole intervals with
 * `-c copy` instead of re-encoding hours of 4K.
 */
export function buildScreenArgs(spec: ScreenSpec): string[] {
  const input = `${spec.display}+${spec.x ?? 0},${spec.y ?? 0}`;
  const isVaapi = spec.codec.endsWith('_vaapi');

  const args: string[] = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'x11grab',
    // Without this the recording shows no pointer, and a screencast whose
    // viewer cannot see what is being clicked is not much of a screencast.
    '-draw_mouse', '1',
    '-framerate', String(spec.fps),
    '-video_size', `${spec.width}x${spec.height}`,
  ];

  if (isVaapi) {
    // The device must be initialised before the input it applies to.
    args.push('-vaapi_device', '/dev/dri/renderD128');
  }

  args.push('-i', input);

  if (isVaapi) {
    // x11grab delivers BGRA in system memory; VAAPI encodes NV12 in GPU memory,
    // so the frame is converted and then uploaded.
    args.push('-vf', 'format=nv12,hwupload', '-c:v', spec.codec, '-qp', VAAPI_QP);
  } else {
    args.push('-c:v', spec.codec, '-preset', 'veryfast', '-crf', X264_CRF, '-pix_fmt', 'yuv420p');
  }

  args.push(
    '-f', 'segment',
    '-segment_time', String(spec.segmentSeconds),
    '-segment_format', 'mp4',
    // Each segment starts at zero. Without this every file carries a global
    // PTS and plays as though it begins hours into the session.
    '-reset_timestamps', '1',
    // Five digits: a four-hour session is ~240 segments, and lexical order must
    // equal chronological order so an editor can concatenate by sorted name.
    join(spec.outDir, 'seg-%05d.mp4'),
  );

  return args;
}

/**
 * Builds the audio capture command.
 *
 * A separate process writing a separate file, never muxed into the video: an
 * editor that can move the audio independently of the picture is the whole
 * point of keeping tracks apart.
 */
export function buildAudioArgs(spec: AudioSpec): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'pulse',
    '-i', spec.source,
    '-c:a', spec.codec,
    '-b:a', `${spec.bitrateKbps}k`,
    '-f', 'segment',
    // The same boundary as video, so both tracks are trimmable at the same
    // points without re-encoding either.
    '-segment_time', String(spec.segmentSeconds),
    '-segment_format', 'mp4',
    '-reset_timestamps', '1',
    join(spec.outDir, 'seg-%05d.m4a'),
  ];
}
