import { APPLIED_RETAINED, AppliedStore, AppliedStoreDeps } from './applied-store';

function makeDeps(initial: string | null = null): AppliedStoreDeps & { contents: string | null } {
  const state = { contents: initial };
  return {
    get contents() {
      return state.contents;
    },
    read: jest.fn(async () => state.contents),
    write: jest.fn(async (contents: string) => {
      state.contents = contents;
    }),
  } as AppliedStoreDeps & { contents: string | null };
}

describe('AppliedStore', () => {
  it('round-trips applied command ids across a restart', async () => {
    // The whole point. The API redelivers an unacknowledged command once its
    // lease expires, and the restart that triggered the redelivery is exactly
    // the event that used to empty the in-memory set -- so the agent would
    // apply a `start` twice and run two ffmpeg trees into one directory.
    const deps = makeDeps();

    await new AppliedStore(deps).save(['c1', 'c2']);

    expect(await new AppliedStore(deps).load()).toEqual(['c1', 'c2']);
  });

  it('returns an empty list when no file exists yet', async () => {
    expect(await new AppliedStore(makeDeps(null)).load()).toEqual([]);
  });

  it('returns an empty list rather than throwing on a corrupt file', async () => {
    // A crash mid-write leaves a partial file. This one loses more than the
    // pending queue does -- an empty applied-set means a redelivered command
    // can be applied twice -- but refusing to start the agent at all is worse,
    // and the API's lease means there is usually nothing outstanding to redeliver.
    expect(await new AppliedStore(makeDeps('{not json')).load()).toEqual([]);
  });

  it('discards a file whose contents are not an array of strings', async () => {
    expect(await new AppliedStore(makeDeps('{"c1":true}')).load()).toEqual([]);
    expect(await new AppliedStore(makeDeps('[1,2,3]')).load()).toEqual([]);
  });

  it('never throws when the write fails, because capture must continue', async () => {
    const deps = makeDeps();
    deps.write = jest.fn(async () => {
      throw new Error('EACCES');
    });

    await expect(new AppliedStore(deps).save(['c1'])).resolves.toBeUndefined();
  });

  it('keeps only the most recent ids, so the file cannot grow without bound', async () => {
    // This file is written on every command for the life of the machine. The
    // retained window only has to outlast the API's redelivery lease, which is
    // measured in seconds, so a few hundred ids is far more than enough.
    const deps = makeDeps();
    const ids = Array.from({ length: APPLIED_RETAINED + 10 }, (_, i) => `c${i}`);

    await new AppliedStore(deps).save(ids);
    const loaded = await new AppliedStore(deps).load();

    expect(loaded).toHaveLength(APPLIED_RETAINED);
    // The newest survive; the oldest are the ones dropped.
    expect(loaded).toContain(`c${APPLIED_RETAINED + 9}`);
    expect(loaded).not.toContain('c0');
  });
});
