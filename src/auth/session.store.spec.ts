import { AuthSession } from './auth-session.entity';
import { SessionStore } from './session.store';

/**
 * A stand-in for the TypeORM repository, holding rows in a Map.
 *
 * The store's job is which rows it writes and which it refuses to return, and
 * that is what these assert. The queries themselves are exercised against a
 * real database by the migration and by the running service.
 */
const repository = () => {
  const rows = new Map<string, AuthSession>();
  return {
    rows,
    save: async (row: AuthSession) => {
      rows.set(row.id, { ...row });
      return row;
    },
    findOne: async ({ where: { id } }: { where: { id: string } }) => rows.get(id) ?? null,
    delete: async (criteria: string | { expiresAt: unknown }) => {
      if (typeof criteria === 'string') {
        rows.delete(criteria);
        return { affected: 1 };
      }
      // The sweep: every row already past its expiry.
      for (const [id, row] of rows) {
        if (row.expiresAt.getTime() <= Date.now()) rows.delete(id);
      }
      return { affected: 0 };
    },
  };
};

const storeWith = (repo: ReturnType<typeof repository>) =>
  new SessionStore(repo as never);

describe('SessionStore', () => {
  it('returns an id far shorter than the token it stores', async () => {
    // The reason this class exists: a ~4KB token in a Set-Cookie header
    // exceeds the 4096-byte limit once the cookie attributes are added, so
    // clients drop it silently and the login appears to succeed.
    const store = storeWith(repository());
    const token = 'x'.repeat(4085);
    const id = await store.create(token, 60_000);

    expect(id.length).toBeLessThan(100);
    expect(await store.get(id)).toBe(token);
  });

  it('issues a different id for every session', async () => {
    const store = storeWith(repository());
    const ids = new Set(await Promise.all([1, 2, 3].map(() => store.create('t', 60_000))));
    expect(ids.size).toBe(3);
  });

  it('returns nothing for an unknown id', async () => {
    expect(await storeWith(repository()).get('never-issued')).toBeNull();
  });

  it('expires a session once its ttl passes', async () => {
    const store = storeWith(repository());
    const id = await store.create('t', -1);
    // Already expired: a stale cookie must not authenticate.
    expect(await store.get(id)).toBeNull();
  });

  it('destroys a session on sign-out', async () => {
    // Clearing only the cookie would leave a usable token for anyone who kept
    // the id.
    const store = storeWith(repository());
    const id = await store.create('t', 60_000);
    await store.destroy(id);
    expect(await store.get(id)).toBeNull();
  });

  it('survives a restart, because the session lives in the database', async () => {
    // The root cause of the reported 401 loop: the store was a Map, so every
    // pod restart invalidated every cookie the browser still held. A new
    // store instance against the same rows must still resolve the session.
    const repo = repository();
    const id = await storeWith(repo).create('tok', 60_000);

    const afterRestart = storeWith(repo);

    expect(await afterRestart.get(id)).toBe('tok');
  });

  it('drops an expired row rather than leaving it to accumulate', async () => {
    // An abandoned browser must not grow the table forever.
    const repo = repository();
    const store = storeWith(repo);
    await store.create('stale', -1);
    await store.create('live', 60_000);

    // Creating a session is when the sweep runs.
    await store.create('another', 60_000);

    expect(repo.rows.size).toBe(2);
  });
});
