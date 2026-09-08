/**
 * Flattens a track's source reference into a single path segment.
 *
 * A webcam's `source_ref` is a device node -- `/dev/video9` -- and interpolating
 * it raw into `<kind>-<source_ref>` yields `webcam-/dev/video9`: three nested
 * directories where the layout contract specifies one. The agent's local
 * directory layout *is* the S3 key layout, so that shape would reach storage.
 *
 * This must stay byte-identical to the agent's copy in
 * `agent/src/capture/session.ts`. The agent builds the keys that are uploaded;
 * the API builds the keys a stored session is verified against. If the two ever
 * disagree, a complete upload is reported as a session with missing objects --
 * the failure that already happened once on the first live save.
 *
 * Display ids (`HDMI-A-0`) and PulseAudio source names contain no slashes and
 * pass through unchanged, which is why no camera was needed to expose this.
 */
export function sourceSlug(sourceRef: string): string {
  return sourceRef.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
}
