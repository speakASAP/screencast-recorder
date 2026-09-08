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

export interface WebcamSpec {
  /** A V4L2 node, e.g. `/dev/video0`, or a v4l2loopback device fed by a phone. */
  device: string;
  /**
   * Capture geometry. Both omitted means "whatever the device is already
   * producing", which is the normal case: nothing upstream knows the camera's
   * resolution, and a phone streaming into a loopback device changes it
   * whenever the operator does.
   */
  width?: number;
  height?: number;
  /**
   * Pins the capture format, e.g. `mjpeg`. Left unset ffmpeg negotiates, which
   * is what a v4l2loopback device needs: it offers exactly one format and
   * naming another makes ffmpeg refuse the device.
   */
  inputFormat?: string;
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

/**
 * Builds the webcam capture command.
 *
 * Deliberately close to `buildScreenArgs` -- same segmenting, same encoder
 * choice -- so a camera track is trimmable on the same boundaries as the screen
 * and the microphone. It differs in three ways that all matter at start-up:
 *
 *   - `-f v4l2` reads a camera node, and rejects `-draw_mouse`.
 *   - Format and geometry are negotiated unless the caller pins them. A USB
 *     webcam advertises both raw YUYV and MJPEG, and raw 720p30 exceeds USB 2.0
 *     bandwidth, so there MJPEG is worth pinning; a v4l2loopback device offers a
 *     single format and refuses to open if told to use any other. Both were
 *     hardcoded here at first, and both broke a real camera:
 *       Cannot find a proper format for codec 'mjpeg' ... Invalid argument
 *   - The source is whatever V4L2 node the operator selected. A phone streaming
 *     into a v4l2loopback device is the same case as a plugged-in webcam, so
 *     nothing here knows or cares which one it is.
 */
export function buildWebcamArgs(spec: WebcamSpec): string[] {
  const isVaapi = spec.codec.endsWith('_vaapi');

  const args: string[] = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'v4l2',
    '-framerate', String(spec.fps),
  ];

  // Only when the caller actually knows the geometry. Asking a 1080p camera for
  // a guessed 720p either downscales it or makes ffmpeg refuse the device.
  if (spec.width && spec.height) {
    args.push('-video_size', `${spec.width}x${spec.height}`);
  }

  // Before -i, because it is an input option: after it, ffmpeg applies it to
  // the output and silently ignores it here.
  if (spec.inputFormat) args.push('-input_format', spec.inputFormat);

  if (isVaapi) {
    // Initialised before the input it applies to, as in buildScreenArgs.
    args.push('-vaapi_device', '/dev/dri/renderD128');
  }

  args.push('-i', spec.device);

  if (isVaapi) {
    // MJPEG decodes to YUV in system memory; VAAPI encodes NV12 in GPU memory.
    args.push('-vf', 'format=nv12,hwupload', '-c:v', spec.codec, '-qp', VAAPI_QP);
  } else {
    args.push('-c:v', spec.codec, '-preset', 'veryfast', '-crf', X264_CRF, '-pix_fmt', 'yuv420p');
  }

  args.push(
    '-f', 'segment',
    '-segment_time', String(spec.segmentSeconds),
    '-segment_format', 'mp4',
    '-reset_timestamps', '1',
    join(spec.outDir, 'seg-%05d.mp4'),
  );

  return args;
}
