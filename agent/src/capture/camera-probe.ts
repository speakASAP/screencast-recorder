/**
 * Proves a camera is delivering frames before a recording commits to it.
 *
 * A v4l2loopback device with no writer is the failure this exists for: the
 * node exists, discovery lists it, and the console offers it -- but it
 * delivers nothing. Without a probe that becomes an empty webcam track,
 * discovered only when the session is played back and cannot be re-recorded.
 */
export function buildProbeArgs(device: string): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    // Bounded: the operator is waiting at session start, and "no signal" is a
    // more useful answer than an indefinite wait.
    //
    // `-timelimit`, not `-timeout`: the latter belongs to the network
    // protocols and the v4l2 demuxer rejects it outright, exiting 8 with
    // "Option timeout not found" before it ever opens the device. A healthy
    // camera then probed as no-signal and blocked every webcam recording.
    '-timelimit', '5',
    '-f', 'v4l2',
    '-i', device,
    '-frames:v', '1',
    '-f', 'null',
    '-',
  ];
}

/**
 * Distinguishes "no signal" from every other ffmpeg failure.
 *
 * The distinction is what the operator acts on: no signal means start the
 * phone app or the puller, while a VAAPI or permission failure means
 * something else entirely. Reporting one as the other sends them to fix the
 * wrong thing.
 */
export function isNoSignal(stderr: string): boolean {
  return (
    /not a video capture device/i.test(stderr) ||
    /no such device/i.test(stderr) ||
    /no such file or directory/i.test(stderr) ||
    /cannot open video device/i.test(stderr) ||
    // A v4l2loopback device with exclusive_caps admits ONE reader, and the
    // console's own live preview is a reader. Pressing Start while watching
    // the preview therefore fails to open the camera -- unusable for the same
    // reason and with the same fix as a dead feed, so it is named here rather
    // than surfacing as an unrecognised ffmpeg error.
    /device or resource busy/i.test(stderr)
  );
}
