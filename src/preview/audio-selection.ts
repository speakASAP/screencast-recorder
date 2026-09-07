/**
 * Levels and initial audio selection for the preview.
 *
 * EVERY source is rendered to its own proxy file and is reachable in the
 * console. This module only decides which one playback starts on, and labels
 * what each source captured.
 *
 * That shape exists because a browser plays only the first audio track of a
 * <video> element and exposes no switcher, so muxing several streams into one
 * file would leave all but the first unreachable. Separate files plus separate
 * <audio> elements is what makes every source actually selectable.
 *
 * "Loudest" is only a starting point, never the whole mechanism: the owner
 * uses different headsets across sessions, so which source carried signal
 * varies. Auto-selecting a single track to render would sometimes render the
 * wrong one and leave the right one unreachable -- and it would fail silently,
 * because a preview that plays some audio looks like it is working.
 */

/** ffmpeg reports a stream with no signal at all as exactly -91.0 dB. */
export const DIGITAL_SILENCE_DB = -91;

export interface AudioSourceLevel {
  sourceRef: string;
  meanDb: number;
  maxDb: number;
}

export interface AudioSourceView extends AudioSourceLevel {
  silent: boolean;
  selected: boolean;
  reason: string;
}

export function parseVolumedetect(stderr: string): { meanDb: number; maxDb: number } {
  const match = (key: string): RegExpMatchArray | null =>
    stderr.match(new RegExp(`${key}:\\s*(-?[0-9.]+) dB`));

  const meanMatch = match('mean_volume');
  const maxMatch = match('max_volume');

  if (!meanMatch && !maxMatch) {
    // ffmpeg's volumedetect filter emits mean_volume and max_volume together
    // on a successful run. Neither being present means the measurement
    // failed to run at all (ffmpeg missing, wrong args, crashed process) --
    // it is not evidence of a quiet stream. Falling back to
    // DIGITAL_SILENCE_DB here would make a failed measurement
    // indistinguishable from a genuinely silent one, and the console would
    // tell the operator "this device was probably not the active input"
    // about a source whose level was never actually measured -- exactly the
    // fact this panel exists to get right.
    throw new Error(
      `parseVolumedetect: could not find mean_volume or max_volume in ffmpeg output: ${stderr.slice(0, 200)}`,
    );
  }

  return {
    meanDb: meanMatch ? Number(meanMatch[1]) : DIGITAL_SILENCE_DB,
    maxDb: maxMatch ? Number(maxMatch[1]) : DIGITAL_SILENCE_DB,
  };
}

export function selectAudioSource(
  levels: AudioSourceLevel[],
  override?: string,
): AudioSourceView[] {
  if (levels.length === 0) return [];

  const loudest = [...levels].sort((a, b) => b.maxDb - a.maxDb)[0];
  const chosen = override && levels.some((l) => l.sourceRef === override) ? override : loudest.sourceRef;
  const byOperator = chosen === override;

  return levels.map((level) => ({
    ...level,
    // Both mean and max at the floor: no signal was present at any point.
    silent: level.meanDb <= DIGITAL_SILENCE_DB && level.maxDb <= DIGITAL_SILENCE_DB,
    selected: level.sourceRef === chosen,
    reason:
      level.sourceRef === chosen
        ? byOperator
          ? 'selected by the operator'
          : 'selected automatically: highest measured level'
        : '',
  }));
}

/**
 * Object key for one source's audio proxy.
 *
 * A PipeWire source ref carries dots and hyphens
 * (alsa_input.usb-_Jabra_Link_390_6CFBEDCB8388-00.mono-fallback), so it is
 * slugged rather than interpolated raw -- an unslugged ref would produce keys
 * that are awkward to round-trip through a URL path segment.
 */
export function audioObjectKey(prefix: string, sourceRef: string): string {
  const slug = sourceRef.replace(/[^A-Za-z0-9_-]+/g, '_');
  return `${prefix}/preview/audio-${slug}.m4a`;
}

/**
 * Names the sources whose proxy is absent.
 *
 * A preview offering two of three sources is worse than one that reports
 * itself incomplete: the missing source is exactly the one the operator would
 * have needed, and a partial set that reports ready hides that.
 */
export function missingAudioProxies(
  expectedSourceRefs: string[],
  renderedKeys: string[],
  prefix: string,
): string[] {
  const rendered = new Set(renderedKeys);
  return expectedSourceRefs.filter((ref) => !rendered.has(audioObjectKey(prefix, ref)));
}
