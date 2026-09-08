import 'reflect-metadata';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SESSION_COOKIE } from './session.constants';
import { UnauthorizedRedirectFilter } from './unauthorized-redirect.filter';

interface Recorded {
  cleared: string[];
  redirectedTo: string | null;
  status: number | null;
  body: unknown;
  res: Response;
}

const host = (req: Partial<Request>): { host: ArgumentsHost; rec: Recorded } => {
  const rec: Recorded = {
    cleared: [],
    redirectedTo: null,
    status: null,
    body: null,
    res: null as unknown as Response,
  };

  const res = {
    clearCookie: (name: string) => {
      rec.cleared.push(name);
      return res;
    },
    redirect: (url: string) => {
      rec.redirectedTo = url;
    },
    status: (code: number) => {
      rec.status = code;
      return res;
    },
    json: (payload: unknown) => {
      rec.body = payload;
      return res;
    },
  } as unknown as Response;

  rec.res = res;

  return {
    rec,
    host: {
      switchToHttp: () => ({
        getRequest: () => req as Request,
        getResponse: () => res,
      }),
    } as unknown as ArgumentsHost,
  };
};

/** A browser navigating to a page; what a reload of /console actually sends. */
const navigation = (url: string, cookies: Record<string, string> = {}) =>
  host({
    originalUrl: url,
    path: url.split('?')[0],
    headers: { accept: 'text/html,application/xhtml+xml' },
    cookies,
  });

describe('UnauthorizedRedirectFilter', () => {
  const filter = new UnauthorizedRedirectFilter();

  it('sends a browser with a dead session to sign in instead of rendering JSON', () => {
    // The reported bug: the pod restarts, the server-side session is gone, the
    // browser still holds the cookie, and every reload of /console rendered
    // {"message":"Session expired"} forever with no way back to a login page.
    const { host: h, rec } = navigation('/console', { [SESSION_COOKIE]: 'stale' });

    filter.catch(new UnauthorizedException('Session expired'), h);

    expect(rec.redirectedTo).toBe('/auth/login?next=%2Fconsole');
  });

  it('clears the dead session cookie on the way out', () => {
    // Without this the browser keeps presenting the same dead id, so the very
    // next request 401s again -- the loop the operator could not escape by
    // reloading.
    const { host: h, rec } = navigation('/console', { [SESSION_COOKIE]: 'stale' });

    filter.catch(new UnauthorizedException('Session expired'), h);

    expect(rec.cleared).toContain(SESSION_COOKIE);
  });

  it('returns the operator to the page they asked for, not just the console', () => {
    const { host: h, rec } = navigation('/sessions/abc', { [SESSION_COOKIE]: 'stale' });

    filter.catch(new UnauthorizedException('Session expired'), h);

    expect(rec.redirectedTo).toBe('/auth/login?next=%2Fsessions%2Fabc');
  });

  it('sends a browser to sign in when the identity provider is unreachable', () => {
    // Auth being down renders {"message":"Identity provider unreachable"} at
    // /console, which offers the operator no way forward. Same treatment as a
    // dead session: go to the login page.
    const { host: h, rec } = navigation('/console', { [SESSION_COOKIE]: 'live' });

    filter.catch(new ServiceUnavailableException('Identity provider unreachable'), h);

    expect(rec.redirectedTo).toBe('/auth/login?next=%2Fconsole');
  });

  it('clears the session cookie on a 503 as well', () => {
    const { host: h, rec } = navigation('/console', { [SESSION_COOKIE]: 'live' });

    filter.catch(new ServiceUnavailableException('Identity provider unreachable'), h);

    expect(rec.cleared).toContain(SESSION_COOKIE);
  });

  it('answers an API call with JSON 503, never a redirect', () => {
    // The machine lane must still see the outage as an outage. A fetch()
    // handed a 302 to a login page cannot tell "auth is down" from "signed
    // out", and the console's retry logic depends on the difference.
    const { host: h, rec } = host({
      originalUrl: '/api/sessions',
      path: '/api/sessions',
      headers: { accept: 'application/json' },
      cookies: { [SESSION_COOKIE]: 'live' },
    });

    filter.catch(new ServiceUnavailableException('Identity provider unreachable'), h);

    expect(rec.redirectedTo).toBeNull();
    expect(rec.status).toBe(503);
  });

  it('answers an API call with JSON 401, never a redirect', () => {
    // The console's fetch() needs a machine-readable answer: a 302 to an HTML
    // login page would be parsed as data and fail in a way that hides the
    // cause.
    const { host: h, rec } = host({
      originalUrl: '/api/sessions',
      path: '/api/sessions',
      headers: { accept: 'application/json' },
      cookies: { [SESSION_COOKIE]: 'stale' },
    });

    filter.catch(new UnauthorizedException('Session expired'), h);

    expect(rec.redirectedTo).toBeNull();
    expect(rec.status).toBe(401);
  });

  it('answers an XHR that accepts html with JSON, because the path is an API path', () => {
    // Some fetch() calls send a permissive Accept header. The path is the
    // reliable signal for the machine lane.
    const { host: h, rec } = host({
      originalUrl: '/api/ui/agents',
      path: '/api/ui/agents',
      headers: { accept: 'text/html' },
      cookies: { [SESSION_COOKIE]: 'stale' },
    });

    filter.catch(new UnauthorizedException('Session expired'), h);

    expect(rec.redirectedTo).toBeNull();
    expect(rec.status).toBe(401);
  });

  it('does not redirect a non-browser client that asked for no html', () => {
    // curl and the agent lane get the status code, not a login page.
    const { host: h, rec } = host({
      originalUrl: '/console',
      path: '/console',
      headers: {},
      cookies: {},
    });

    filter.catch(new UnauthorizedException('Session expired'), h);

    expect(rec.redirectedTo).toBeNull();
    expect(rec.status).toBe(401);
  });
});
