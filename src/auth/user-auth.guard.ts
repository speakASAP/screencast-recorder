import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AGENT_ROUTE } from './agent-roles.decorator';
import { PUBLIC_ROUTE } from './public.decorator';
import { SESSION_COOKIE } from './session.constants';
import { SessionStore } from './session.store';

export interface OperatorUser {
  id: string;
  email: string;
  roles?: string[];
}

/**
 * Guards the operator surface: the console and the routes it calls.
 *
 * The session lives in an HTTP-only cookie set by the callback route, and the
 * token is validated server-side on every request. Page JavaScript never holds
 * a token, so an XSS on the console cannot lift a credential.
 *
 * This is the human lane. Machine callers use AgentRoleGuard with a
 * pair-specific service token; the two are never interchangeable.
 */
@Injectable()
export class UserAuthGuard implements CanActivate {
  private readonly logger = new Logger(UserAuthGuard.name);

  private readonly authUrl = process.env.AUTH_SERVICE_URL ?? 'https://auth.alfares.cz';

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Machine routes carry a pair-specific service token, not a cookie, and
    // are guarded by AgentRoleGuard instead. Deferring here keeps the two
    // identity lanes separate, as the service identity standard requires -- it
    // does NOT leave them unguarded.
    const isAgentRoute = this.reflector.getAllAndOverride<boolean>(AGENT_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isAgentRoute) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: OperatorUser }>();
    const sessionId = request.cookies?.[SESSION_COOKIE];
    if (!sessionId) throw new UnauthorizedException('Not signed in');

    // The cookie holds an opaque id; the token lives server-side, in the
    // database, so it survives the restart that used to invalidate it.
    const token = await this.sessions.get(sessionId);
    if (!token) throw new UnauthorizedException('Session expired');

    request.user = await this.validate(token);
    return true;
  }

  /**
   * A rejected credential and an unreachable Auth are different outcomes and
   * must stay distinguishable: 401 sends the operator to sign in again, 503
   * says the identity provider is down. Collapsing them would hide an outage
   * behind a login loop.
   */
  private async validate(token: string): Promise<OperatorUser> {
    let response: Response;
    try {
      response = await fetch(`${this.authUrl}/auth/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      this.logger.error(`Auth unreachable: ${(error as Error).name}`);
      throw new ServiceUnavailableException('Identity provider unreachable');
    }

    if (!response.ok) throw new UnauthorizedException('Session rejected');

    const body = (await response.json()) as { valid?: boolean; user?: OperatorUser };

    // A 200 carrying valid:false is a rejection. Reading response.ok alone
    // would accept every expired session.
    if (body.valid !== true || !body.user) throw new UnauthorizedException('Session expired');

    return body.user;
  }
}
