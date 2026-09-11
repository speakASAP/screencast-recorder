export interface PurgeDeps {
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}

/**
 * `sessions/YYYY/MM/DD/<session-id>` and nothing shallower.
 *
 * The final segment is deliberately "one or more non-slash characters"
 * rather than a UUID-length pattern: production session ids are UUIDs, but
 * pinning the regex to that exact shape would refuse a legitimate prefix the
 * day the id format changes, without adding any real safety -- the
 * dangerous case this guards against is a prefix with too few segments
 * (`sessions/2026`, `sessions/2026/09/11`), not a session id of a
 * particular length.
 */
const SESSION_PREFIX = /^sessions\/\d{4}\/\d{2}\/\d{2}\/[^/]+$/;

/**
 * Deletes every object belonging to one discarded session.
 *
 * This is the only code in the service that deletes stored media, and it exists
 * because continuous upload puts objects in the bucket before the operator has
 * decided to keep them. Discard is an explicit operator request, which is what
 * the retention rules require of a deletion path.
 *
 * The prefix shape is checked rather than trusted: the difference between one
 * session and a month of them is a few characters.
 */
export async function purgePrefix(deps: PurgeDeps, prefix: string): Promise<number> {
  if (!SESSION_PREFIX.test(prefix)) {
    throw new Error(`refusing to purge: ${prefix || '(empty)'} is not a session prefix`);
  }

  // Filtered again after listing: if `list` ever returned something broader
  // than the prefix it was asked for, the blast radius must still be one
  // session, not whatever it handed back.
  const keys = (await deps.list(prefix)).filter((key) => key.startsWith(`${prefix}/`));

  for (const key of keys) {
    await deps.remove(key);
  }

  return keys.length;
}
