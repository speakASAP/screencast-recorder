import { sessionRedirect } from './session-redirect.middleware';

const call = (path: string, cookies: Record<string, string> = {}) => {
  const res = { redirect: jest.fn() };
  const next = jest.fn();
  sessionRedirect({ path, cookies } as never, res as never, next as never);
  return { res, next };
};

describe('sessionRedirect', () => {
  it('sends an unauthenticated browser to sign in', () => {
    // Static middleware runs before guards, so without this the console HTML
    // renders for anyone and every panel then fails with a 401.
    const { res, next } = call('/');
    expect(res.redirect).toHaveBeenCalledWith('/auth/login');
    expect(next).not.toHaveBeenCalled();
  });

  it('lets a signed-in browser through', () => {
    const { res, next } = call('/', { screencast_session: 'token' });
    expect(next).toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('never redirects the health endpoint', () => {
    // A redirect here would fail the Kubernetes probe and roll the pod.
    const { next } = call('/health');
    expect(next).toHaveBeenCalled();
  });

  it('never redirects API routes, which answer 401 instead', () => {
    // An API caller needs a status code, not an HTML login page.
    const { next } = call('/api/sessions');
    expect(next).toHaveBeenCalled();
  });

  it('never redirects the login flow itself', () => {
    // Redirecting /auth/login to /auth/login is an infinite loop.
    for (const path of ['/auth/login', '/auth/callback', '/auth/session']) {
      const { next } = call(path);
      expect(next).toHaveBeenCalled();
    }
  });

  it('serves static assets without a session so the login page can style itself', () => {
    const { next } = call('/style.css');
    expect(next).toHaveBeenCalled();
  });
});
