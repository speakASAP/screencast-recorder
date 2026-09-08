/**
 * Builds the ffmpeg invocations for a preview render.
 *
 * Rendering runs here rather than in the API because the API pod has 500m of
 * CPU, no /dev/dri and no ffmpeg binary: software-only rendering there
 * measured 98-123 minutes for a four-hour session while also serving the
 * console. This host has the GPU, the cores and the files.
 *
 * A render produces a SILENT video proxy plus one audio proxy per capture
 * source. The split exists because a browser plays only the first audio track
 * of a <video> element and exposes no switcher, so muxing would leave every
 * source but one permanently unreachable -- and the owner uses different
 * headsets across sessions, so which source carried signal varies.
 *
 * Measured on a real 15.2-minute stored session on this host: 65 MB of 4K
 * source rendered to a 4.4 MB proxy in 39.8 seconds, and one audio source to
 * 245 KB in 0.8 seconds. Extrapolated to four hours that is roughly 70 MB of
 * video and about 10 minutes of GPU time -- an order of magnitude longer than
 * the 90 seconds the original design estimated, which is why a render must be
 * shown to the operator as work in progress rather than absorbed as a delay.
 *
 * The split is also cheaper than muxing, because AAC compresses digital
 * silence about thirtyfold: the Jabra source above measured -91.0 dB
 * throughout and encoded at 700 bit/s against its nominal 24 kbps, so the
 * sources that carried nothing cost almost nothing.
 *
 * Argument construction is separated from execution so the flags that matter
 * -- faststart above all -- are testable without spawning ffmpeg.
 */

export const VAAPI_DEVICE = '/dev/dri/renderD128';

/**
 * An ffmpeg concat list.
 *
 * The quote escaping is depth rather than a live hole: these paths are
 * agent-generated. But a concat list is read as a small script, so an
 * unescaped quote would end the entry early and silently render a truncated
 * session -- the kind of quiet partial result this project treats as worse
 * than a failure.
 */
export function buildConcatList(paths: string[]): string {
  return paths.map((path) => `file '${path.replace(/'/g, "'\\''")}'\n`).join('');
}

/** The screen proxy. Deliberately silent: audio ships as separate files. */
export function buildVideoProxyArgs(concatListPath: string, outPath: string): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    '-vaapi_device',
    VAAPI_DEVICE,
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-an',
    '-vf',
    'scale=960:540,format=nv12,hwupload',
    '-c:v',
    'h264_vaapi',
    '-qp',
    '32',
    '-r',
    '10',
    // The whole point: moov at the front, so the browser can seek without
    // downloading the file first.
    '-movflags',
    '+faststart',
    outPath,
  ];
}

/**
 * One source's audio proxy.
 *
 * 24 kbps mono at 22.05 kHz: speech stays intelligible, and intelligibility
 * is the entire requirement. At 64 kbps three sources would outweigh the
 * video four to one.
 */
export function buildAudioProxyArgs(concatListPath: string, outPath: string): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '24k',
    '-ac',
    '1',
    '-ar',
    '22050',
    '-movflags',
    '+faststart',
    outPath,
  ];
}

/**
 * Measures a source's level without producing an output file.
 *
 * Stays at `-v info` deliberately: volumedetect reports mean_volume and
 * max_volume at info level, and quietening ffmpeg would make every source
 * measure as unparseable.
 */
export function buildVolumedetectArgs(concatListPath: string): string[] {
  return [
    '-v',
    'info',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ];
}

/**
 * Decodes one source to raw mono PCM for peak extraction.
 *
 * Reads the same concat list the audio proxy is built from, so the drawn
 * waveform describes exactly the file the operator hears rather than a
 * separately-assembled approximation.
 *
 * 8 kHz mono is far below speech fidelity, and deliberately so: nothing here
 * is played back. A waveform lane is a few thousand pixels wide, so decoding a
 * four-hour session at full rate would spend minutes of CPU to draw an
 * envelope that 8 kHz already over-describes. Output goes to stdout because a
 * temp file per source would be written once and read once.
 */
export function buildPeaksArgs(concatListPath: string): string[] {
  return [
    '-v', 'error',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-vn',
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    '-ac', '1',
    '-ar', '8000',
    'pipe:1',
  ];
}

/** Full scale for signed 16-bit PCM. */
const PCM_FULL_SCALE = 32767;

/**
 * Reduces raw PCM to one peak per bucket, each a 0..1 fraction of full scale.
 *
 * The peak is the maximum ABSOLUTE sample in the bucket, not the mean. Speech
 * is symmetric around zero, so averaging signed samples cancels to roughly
 * nothing and would draw a talking track as a flat line.
 *
 * An empty stream yields silence rather than an error: a source that captured
 * nothing is a fact the operator needs drawn, and failing the whole render
 * over it would lose the sources that did work.
 */
export function peaksFromPcm(pcm: Buffer, buckets: number): number[] {
  const peaks = new Array<number>(buckets).fill(0);
  const total = Math.floor(pcm.length / 2);
  if (total === 0 || buckets <= 0) return peaks;

  const perBucket = total / buckets;

  for (let index = 0; index < total; index += 1) {
    const bucket = Math.min(buckets - 1, Math.floor(index / perBucket));
    // Math.abs of -32768 exceeds full scale by one; clamping keeps every
    // bucket inside 0..1 so the drawing code never has to.
    const sample = Math.min(Math.abs(pcm.readInt16LE(index * 2)), PCM_FULL_SCALE);
    if (sample > peaks[bucket]) peaks[bucket] = sample;
  }

  return peaks.map((peak) => peak / PCM_FULL_SCALE);
}
