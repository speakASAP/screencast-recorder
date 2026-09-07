import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE } from './session.constants';

/**
 * Sends an unauthenticated browser to sign in before the console is served.
 *
 * Static file middleware runs ahead of Nest guards, so without this the page
 * HTML would render for anyone -- the API calls behind it would all 401, but
 * the operator would see a broken console rather than a login page.
 *
 * This is a routing convenience, not the security boundary: every route that
 * returns data is guarded independently. A forged cookie gets a rendered page
 * and 401s on every request, which is why the cookie is only checked for
 * presence here and validated properly by UserAuthGuard.
 */
export function sessionRedirect(req: Request, res: Response, next: NextFunction): void {
  const isAsset = /\.(css|js|png|svg|ico|woff2?)$/.test(req.path);
  const isExempt = req.path.startsWith('/auth/') || req.path === '/health' || req.path.startsWith('/api/');

  if (isAsset || isExempt) return next();
  if (req.cookies?.[SESSION_COOKIE]) return next();

  res.redirect('/auth/login');
}
