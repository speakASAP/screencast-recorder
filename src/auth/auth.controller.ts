import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Public } from './public.decorator';
import { SESSION_COOKIE, STATE_COOKIE } from './session.constants';

const AUTH_UI = process.env.AUTH_PUBLIC_URL ?? 'https://auth.alfares.cz';
const APP_ORIGIN = process.env.APP_PUBLIC_URL ?? 'https://screencast.alfares.cz';
const CLIENT_ID = 'screencast-recorder';

/** Hosted Auth sign-in, per HOSTED_AUTH_CONSUMER_STANDARD.md. */
@Controller('auth')
export class AuthController {
  /**
   * Sends the operator to hosted Auth.
   *
   * State is generated here and stored in a short-lived HTTP-only cookie so
   * the callback can prove the response belongs to a redirect this server
   * started, rather than one an attacker induced.
   */
  @Get('login')
  @Public()
  login(@Res() res: Response): void {
    const state = randomUUID();

    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
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
    body: JSON.stringify({ access_token: token, state }),
  });
  if (r.ok) location.replace('/');
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
  @HttpCode(204)
  session(
    @Body() body: { access_token?: string; state?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    const expected = req.cookies?.[STATE_COOKIE];

    if (!body.access_token) throw new BadRequestException('missing access_token');
    if (!expected || body.state !== expected) {
      throw new BadRequestException('state mismatch; start again from /auth/login');
    }

    res.clearCookie(STATE_COOKIE, { path: '/' });
    res.cookie(SESSION_COOKIE, body.access_token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      // Matches Auth's own access-token lifetime closely enough; the guard
      // validates server-side on every request regardless, so an expired
      // token is rejected even if the cookie outlives it.
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
    });
    res.status(204).send();
  }

  @Get('logout')
  @Public()
  logout(@Res() res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect('/auth/login');
  }

  /** Who is signed in; used by the console to show the operator. */
  @Get('me')
  me(@Req() req: Request & { user?: { email: string } }) {
    return { email: req.user?.email ?? null };
  }
}
