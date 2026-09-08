import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Public } from './public.decorator';
import { SessionStore } from './session.store';
import { NEXT_COOKIE, SESSION_COOKIE, STATE_COOKIE } from './session.constants';

const AUTH_UI = process.env.AUTH_PUBLIC_URL ?? 'https://auth.alfares.cz';
const APP_ORIGIN = process.env.APP_PUBLIC_URL ?? 'https://screencast.alfares.cz';
const CLIENT_ID = 'screencast-recorder';

/** Hosted Auth sign-in, per HOSTED_AUTH_CONSUMER_STANDARD.md. */
@Controller('auth')
export class AuthController {
  constructor(private readonly sessions: SessionStore) {}

  /**
   * Sends the operator to hosted Auth.
   *
   * State is generated here and stored in a short-lived HTTP-only cookie so
   * the callback can prove the response belongs to a redirect this server
   * started, rather than one an attacker induced.
   */
  @Get('login')
  @Public()
  login(@Res() res: Response, @Query('next') next?: string): void {
    const state = randomUUID();

    // Remember the intended destination across the Auth round trip. Only a
    // same-site path is accepted: an absolute URL here would turn the login
    // into an open redirect that could bounce a signed-in operator to an
    // attacker's page.
    const destination = typeof next === 'string' && /^\/[^/\\]/.test(next) ? next : '/console';
    res.cookie(NEXT_COOKIE, destination, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 10 * 60 * 1000,
      path: '/',
    });

    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      // 'none', not 'lax'. The browser leaves for auth.alfares.cz and comes
      // back, and the callback page then reads this cookie from a fetch()
      // rather than a top-level navigation. Lax withholds the cookie in that
      // case, so the state check fails with "state mismatch" on every login.
      // Safe here because the value is a single-use random token that carries
      // no authority, and it is cleared as soon as it is used.
      sameSite: 'none',
      maxAge: 10 * 60 * 1000,
      path: '/',
    });

    const url = new URL('/login', AUTH_UI);
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('return_url', `${APP_ORIGIN}/auth/callback`);
    url.searchParams.set('state', state);

    res.redirect(url.toString());
  }

  /**
   * Receives the redirect back from Auth.
   *
   * Auth returns tokens in the URL *fragment*, which a server never sees, so
   * this serves a tiny page that reads the fragment, hands the token to
   * /auth/session over POST, and clears it from history. The token reaches an
   * HTTP-only cookie and is never stored where page script can read it.
   */
  @Get('callback')
  @Public()
  callback(@Res() res: Response): void {
    res.type('html').send(`<!doctype html>
<meta charset="utf-8"><title>Signing in…</title>
<body style="background:#12141a;color:#e7e9ee;font:15px system-ui;padding:2rem">
<p id="m">Signing in…</p>
<script>
(async () => {
  const p = new URLSearchParams(location.hash.slice(1));
  const token = p.get('access_token');
  const state = p.get('state');
  // Clear the fragment before anything else can read it from history.
  history.replaceState(null, '', location.pathname);
  if (!token) { document.getElementById('m').textContent = 'Sign-in failed: no token returned.'; return; }
  const r = await fetch('/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Without this the state cookie is not sent at all and the exchange fails
    // with "state mismatch" even when the state is correct.
    credentials: 'same-origin',
    body: JSON.stringify({ access_token: token, state }),
  });
  if (r.ok) {
    const body = await r.json().catch(() => ({}));
    location.replace(body.next || '/console');
  }
  else document.getElementById('m').textContent = 'Sign-in failed: ' + (await r.text());
})();
</script>
</body>`);
  }

  /**
   * Exchanges the fragment token for an HTTP-only session cookie.
   *
   * The state must match the cookie set before the redirect; without that
   * check a token obtained elsewhere could be planted into this browser's
   * session. The cookie is HttpOnly and Secure so page script cannot read the
   * token back out.
   */
  @Post('session')
  @Public()
  @HttpCode(200)
  async session(
    @Body() body: { access_token?: string; state?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const expected = req.cookies?.[STATE_COOKIE];

    if (!body.access_token) throw new BadRequestException('missing access_token');

    // Distinguish the two failures. A missing cookie is a delivery problem
    // (SameSite, an expired 10-minute window, cookies blocked); a present but
    // different value is a genuine CSRF signal. Reporting both as "state
    // mismatch" sends the reader hunting for an attack when the cause is a
    // cookie that never arrived.
    if (!expected) {
      throw new BadRequestException(
        'sign-in state cookie missing or expired; start again from /auth/login',
      );
    }
    if (body.state !== expected) {
      throw new BadRequestException('state mismatch; start again from /auth/login');
    }

    res.clearCookie(STATE_COOKIE, { path: '/' });

    // The cookie carries an opaque session id, not the token. This operator's
    // token is ~4KB (83 roles), and a Set-Cookie carrying it exceeds the
    // 4096-byte limit, so clients drop it silently and the login appears to
    // work while every later request is unauthenticated.
    const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
    const sessionId = await this.sessions.create(body.access_token, SESSION_TTL_MS);

    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      // Matches Auth's own access-token lifetime closely enough; the guard
      // validates server-side on every request regardless, so an expired
      // token is rejected even if the cookie outlives it.
      maxAge: SESSION_TTL_MS,
      path: '/',
    });

    const destination = req.cookies?.[NEXT_COOKIE] || '/console';
    res.clearCookie(NEXT_COOKIE, { path: '/' });
    res.status(200).json({ next: destination });
  }

  @Get('logout')
  @Public()
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const id = req.cookies?.[SESSION_COOKIE];
    // Drop the server-side entry too: clearing only the cookie would leave a
    // usable token in memory for anyone who kept the id.
    if (id) await this.sessions.destroy(id);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    // Back to the public page, not straight into another sign-in.
    res.redirect('/');
  }

  /** Who is signed in; used by the console to show the operator. */
  @Get('me')
  me(@Req() req: Request & { user?: { email: string } }) {
    return { email: req.user?.email ?? null };
  }
}
