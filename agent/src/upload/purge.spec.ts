import { purgePrefix, PurgeDeps } from './purge';

function makeDeps(keys: string[]): PurgeDeps & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    list: jest.fn(async () => keys),
    remove: jest.fn(async (key: string) => {
      removed.push(key);
    }),
  } as PurgeDeps & { removed: string[] };
}

describe('purgePrefix', () => {
  it('deletes every object under the session prefix', async () => {
    const deps = makeDeps([
      'sessions/2026/09/11/s1/manifest.json',
      'sessions/2026/09/11/s1/alfares/screen-HDMI-A-0/seg-00000.mp4',
    ]);

    const count = await purgePrefix(deps, 'sessions/2026/09/11/s1');

    expect(count).toBe(2);
    expect(deps.removed).toHaveLength(2);
  });

  it('refuses a prefix that is not a single session', async () => {
    // The guard that matters. `sessions/2026` would delete a month of work,
    // and this function is the only delete path in the service.
    const deps = makeDeps(['sessions/2026/09/11/s1/manifest.json']);

    await expect(purgePrefix(deps, 'sessions/2026')).rejects.toThrow(/not a session prefix/);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('refuses an empty prefix', async () => {
    const deps = makeDeps([]);
    await expect(purgePrefix(deps, '')).rejects.toThrow(/not a session prefix/);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('never deletes a key from outside the prefix it was given', async () => {
    // A defensive second check: if list ever returned something broader, the
    // blast radius must still be one session.
    const deps = makeDeps([
      'sessions/2026/09/11/s1/manifest.json',
      'sessions/2026/09/11/s2/manifest.json',
    ]);

    await purgePrefix(deps, 'sessions/2026/09/11/s1');

    expect(deps.removed).toEqual(['sessions/2026/09/11/s1/manifest.json']);
  });

  it('succeeds when there is nothing to delete', async () => {
    const deps = makeDeps([]);
    expect(await purgePrefix(deps, 'sessions/2026/09/11/s1')).toBe(0);
  });
});
