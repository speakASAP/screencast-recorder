import 'reflect-metadata';
import { AuthController } from './auth.controller';
import { SessionStore } from './session.store';

/** In-memory stand-in for the auth_sessions repository. */
const store = () => {
  const rows = new Map<string, { id: string; token: string; expiresAt: Date }>();
  return new SessionStore({
    save: async (row: { id: string; token: string; expiresAt: Date }) => {
      rows.set(row.id, row);
      return row;
    },
    findOne: async ({ where: { id } }: { where: { id: string } }) => rows.get(id) ?? null,
    delete: async () => ({ affected: 0 }),
  } as never);
};

const res = () => {
  const r: any = {};
  r.cookie = jest.fn().mockReturnValue(r);
  r.clearCookie = jest.fn().mockReturnValue(r);
  r.redirect = jest.fn().mockReturnValue(r);
  r.status = jest.fn().mockReturnValue(r);
  r.send = jest.fn().mockReturnValue(r);
  r.type = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  r.sendFile = jest.fn().mockReturnValue(r);
  return r;
};

describe('AuthController state handling', () => {
  const controller = () => new AuthController(store());

  it('sets the state cookie with SameSite=None so it survives the Auth round trip', () => {
    // The browser leaves for auth.alfares.cz and returns, then reads this
    // cookie from a fetch(). Lax withholds it there, which failed every login
    // with "state mismatch".
    const r = res();
    controller().login(r);
    const [, , options] = r.cookie.mock.calls[0];
    expect(options.sameSite).toBe('none');
    expect(options.secure).toBe(true);
    expect(options.httpOnly).toBe(true);
  });

  it('says the cookie is missing rather than blaming the state value', async () => {
    // A missing cookie is a delivery problem; a differing value is a CSRF
    // signal. One message for both sends the reader hunting an attack.
    const r = res();
    await expect(
      controller().session({ access_token: 't', state: 'x' }, { cookies: {} } as never, r),
    ).rejects.toThrow(/missing or expired/i);
  });

  it('still rejects a genuinely mismatched state', async () => {
    const r = res();
    await expect(
      controller().session(
        { access_token: 't', state: 'attacker' },
        { cookies: { screencast_auth_state: 'real' } } as never,
        r,
      ),
    ).rejects.toThrow(/state mismatch/i);
  });

  it('accepts a matching state and sets a session cookie', async () => {
    const r = res();
    await controller().session(
      { access_token: 'the-token', state: 'match' },
      { cookies: { screencast_auth_state: 'match' } } as never,
      r,
    );
    const call = r.cookie.mock.calls.find((c: unknown[]) => c[0] === 'screencast_session');
    expect(call).toBeDefined();
    // The cookie holds a short opaque id, never the token itself.
    expect(call[1]).not.toBe('the-token');
    expect(call[1].length).toBeLessThan(100);
  });
});

describe('post-sign-in destination', () => {
  const controller = () => new AuthController(store());

  it('returns the remembered destination so the callback lands there', async () => {
    const r = res();
    await controller().session(
      { access_token: 't', state: 'm' },
      { cookies: { screencast_auth_state: 'm', screencast_auth_next: '/console' } } as never,
      r,
    );
    expect(r.json).toHaveBeenCalledWith({ next: '/console' });
  });

  it('refuses an absolute URL as a destination, which would be an open redirect', () => {
    // A login that can bounce a signed-in operator to an arbitrary origin is a
    // phishing primitive, so only a same-site path is accepted.
    const r = res();
    controller().login(r, 'https://evil.example/steal');
    const next = r.cookie.mock.calls.find((c: unknown[]) => c[0] === 'screencast_auth_next');
    expect(next[1]).toBe('/console');
  });

  it('refuses a protocol-relative destination too', () => {
    const r = res();
    controller().login(r, '//evil.example/steal');
    const next = r.cookie.mock.calls.find((c: unknown[]) => c[0] === 'screencast_auth_next');
    expect(next[1]).toBe('/console');
  });

  it('keeps a legitimate same-site path', () => {
    const r = res();
    controller().login(r, '/console');
    const next = r.cookie.mock.calls.find((c: unknown[]) => c[0] === 'screencast_auth_next');
    expect(next[1]).toBe('/console');
  });
});
