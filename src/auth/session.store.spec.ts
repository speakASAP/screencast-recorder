import { SessionStore } from './session.store';

describe('SessionStore', () => {
  it('returns an id far shorter than the token it stores', () => {
    // The reason this class exists: a ~4KB token in a Set-Cookie header
    // exceeds the 4096-byte limit once the cookie attributes are added, so
    // clients drop it silently and the login appears to succeed.
    const store = new SessionStore();
    const token = 'x'.repeat(4085);
    const id = store.create(token, 60_000);

    expect(id.length).toBeLessThan(100);
    expect(store.get(id)).toBe(token);
  });

  it('issues a different id for every session', () => {
    const store = new SessionStore();
    const ids = new Set([1, 2, 3].map(() => store.create('t', 60_000)));
    expect(ids.size).toBe(3);
  });

  it('returns nothing for an unknown id', () => {
    expect(new SessionStore().get('never-issued')).toBeNull();
  });

  it('expires a session once its ttl passes', () => {
    const store = new SessionStore();
    const id = store.create('t', -1);
    // Already expired: a stale cookie must not authenticate.
    expect(store.get(id)).toBeNull();
  });

  it('destroys a session on sign-out', () => {
    // Clearing only the cookie would leave a usable token in memory for anyone
    // who kept the id.
    const store = new SessionStore();
    const id = store.create('t', 60_000);
    store.destroy(id);
    expect(store.get(id)).toBeNull();
  });
});
