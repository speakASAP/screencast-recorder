/**
 * The segments in a track directory that are finished and safe to upload.
 *
 * ffmpeg is always writing the highest-numbered segment, so it is excluded: an
 * object PUT from a file still being appended to lands short, and the size
 * check that makes a resumed upload cheap would then skip it for ever as
 * "already present".
 */
export function closedSegments(names: string[]): string[] {
  const segments = names
    .filter((name) => /^seg-\d+\./.test(name))
    .map((name) => ({ name, index: Number(name.slice(4, name.indexOf('.'))) }))
    .sort((a, b) => a.index - b.index);

  return segments.slice(0, -1).map((s) => s.name);
}
