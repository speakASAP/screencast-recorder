import { PendingStore, PendingStoreDeps } from './pending-store';

function makeDeps(initial: string | null = null): PendingStoreDeps & { contents: string | null } {
  const state = { contents: initial };
  return {
    get contents() {
      return state.contents;
    },
    read: jest.fn(async () => state.contents),
    write: jest.fn(async (contents: string) => {
      state.contents = contents;
    }),
  } as PendingStoreDeps & { contents: string | null };
}

describe('PendingStore', () => {
  it('round-trips queued reports across a restart', async () => {
    // A failure report that dies with the process is why a session sat in
    // `uploading` for ever with no reason recorded anywhere.
    const deps = makeDeps();
    const store = new PendingStore(deps);

    await store.save([{ path: '/api/sessions/s1/status', body: { state: 'failed' } }]);
    const loaded = await new PendingStore(deps).load();

    expect(loaded).toEqual([{ path: '/api/sessions/s1/status', body: { state: 'failed' } }]);
  });

  it('returns an empty queue when no file exists yet', async () => {
    const store = new PendingStore(makeDeps(null));
    expect(await store.load()).toEqual([]);
  });

  it('returns an empty queue rather than throwing on a corrupt file', async () => {
    // A crash mid-write leaves a partial line. Losing the queue is bad; failing
    // to start the agent because of it is worse.
    const store = new PendingStore(makeDeps('{not json'));
    expect(await store.load()).toEqual([]);
  });

  it('discards a file whose contents are not an array', async () => {
    const store = new PendingStore(makeDeps('{"path":"/x"}'));
    expect(await store.load()).toEqual([]);
  });

  it('never throws when the write fails, because capture must continue', async () => {
    const deps = makeDeps();
    deps.write = jest.fn(async () => {
      throw new Error('EACCES');
    });
    const store = new PendingStore(deps);

    await expect(store.save([{ path: '/x', body: {} }])).resolves.toBeUndefined();
  });
});
