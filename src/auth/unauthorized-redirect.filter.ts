import { ArgumentsHost, Catch, ExceptionFilter, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SESSION_COOKIE } from './session.constants';

/**
 * Turns a rejected session into a trip to the login page, for browsers only.
 *
 * The session cookie outlives the session it names -- a token expires, an
 * operator signs out elsewhere -- and the browser keeps presenting the dead
 * id. Without this the guard's 401 was rendered as JSON, so reloading
 * /console showed {"message":"Session expired"} forever: the page offered no
 * way to sign in, and the cookie that caused it was never cleared, so every
 * reload reproduced it exactly.
 *
 * Clearing the cookie is half the fix. A redirect alone would bounce the
 * browser to /auth/login, but the session-redirect middleware waves through
 * anything holding a cookie, so the dead id would sail past it and 401 again.
 *
 * Machine callers keep the status code. A fetch() handed a 302 to an HTML
 * login page parses the page as data and fails somewhere further along, which
 * hides the cause; the console's client script checks for 401 instead.
 */
@Catch(UnauthorizedException)
export class UnauthorizedRedirectFilter implements ExceptionFilter {
  catch(exception: UnauthorizedException, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    if (this.isPageNavigation(request)) {
      // Drop the credential that cannot work, so the next request is a clean
      // signed-out one rather than a repeat of this failure.
      response.clearCookie(SESSION_COOKIE, { path: '/' });

      const destination = request.originalUrl || '/console';
      response.redirect(`/auth/login?next=${encodeURIComponent(destination)}`);
      return;
    }

    const status = exception.getStatus();
    response.status(status).json(exception.getResponse());
  }

  /**
   * A top-level navigation, as opposed to a fetch() from the console.
   *
   * The path is checked first and wins: some fetch() calls send a permissive
   * Accept header, and answering one of those with a redirect is the failure
   * this distinction exists to avoid.
   */
  private isPageNavigation(request: Request): boolean {
    if (request.path?.startsWith('/api/')) return false;
    const accept = request.headers?.accept ?? '';
    return accept.includes('text/html');
  }
}
