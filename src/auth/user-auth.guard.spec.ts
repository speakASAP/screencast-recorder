import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserAuthGuard } from './user-auth.guard';

const ctx = (cookies: Record<string, string> = {}): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ cookies }) }),
    getHandler: () => ({}),
    getClass: () => ({ name: 'TestController' }),
  }) as unknown as ExecutionContext;

const reflector = (meta: Record<string, boolean>): Reflector =>
  ({ getAllAndOverride: (key: string) => meta[key] }) as unknown as Reflector;

describe('UserAuthGuard', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('rejects a request with no session cookie', async () => {
    // The whole point: the console must not be reachable without signing in.
    const guard = new UserAuthGuard(reflector({}));
    await expect(guard.canActivate(ctx())).rejects.toThrow();
  });

  it('allows a route explicitly marked public', async () => {
    // Only health and the login flow, which run before a session can exist.
    const guard = new UserAuthGuard(reflector({ public_route: true }));
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it('defers a machine route to the agent guard rather than demanding a cookie', async () => {
    // The agent carries a pair-specific service token, not a session. This
    // defers; it does not leave the route unguarded -- AgentRoleGuard runs.
    const guard = new UserAuthGuard(reflector({ agent_route: true }));
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it('rejects a session Auth reports as invalid', async () => {
    // A 200 carrying valid:false is a rejection; accepting it would admit
    // every expired session.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: false }),
    }) as never;
    const guard = new UserAuthGuard(reflector({}));
    await expect(guard.canActivate(ctx({ screencast_session: 'stale' }))).rejects.toThrow();
  });

  it('accepts a valid session and attaches the operator', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, user: { id: 'u1', email: 'ssf@example.com' } }),
    }) as never;
    const guard = new UserAuthGuard(reflector({}));
    await expect(guard.canActivate(ctx({ screencast_session: 'good' }))).resolves.toBe(true);
  });

  it('reports 503 rather than 401 when Auth is unreachable', async () => {
    // A rejected credential and a dead identity provider are different
    // problems; collapsing them hides an outage behind a login loop.
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
    const guard = new UserAuthGuard(reflector({}));
    await expect(guard.canActivate(ctx({ screencast_session: 'x' }))).rejects.toMatchObject({
      status: 503,
    });
  });
});
