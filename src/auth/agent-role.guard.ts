import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AGENT_ROUTE } from './agent-roles.decorator';
import { TokenValidator } from './token-validator';

/**
 * The one role this service accepts from a machine caller, per
 * SERVICE_IDENTITY_CONSUMER_STANDARD.md: one Auth-signed RS256 principal per
 * (caller -> target) pair, least privilege, never global:superadmin.
 */
const REQUIRED_ROLE = 'internal:screencast-recorder:agent';

@Injectable()
export class AgentRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly validator: TokenValidator,
    private readonly logger: Logger = new Logger(AgentRoleGuard.name),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.reflector.getAllAndOverride<boolean>(AGENT_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!declared) {
      // Fail closed and say so. An undecorated machine-accessible route is a
      // defect, not a default-open case, and a silent denial would hide it.
      this.logger.error(
        `Denied an undecorated machine-accessible route on ${context.getClass().name}; ` +
          'every such route must declare its allowed service role',
      );
      throw new ForbiddenException('Route declares no service role');
    }

    const header: string | undefined = context.switchToHttp().getRequest().headers?.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const claims = await this.validator.validate(header.slice('Bearer '.length));
    if (!claims?.roles?.includes(REQUIRED_ROLE)) {
      // Log the decision, never the credential.
      this.logger.warn(`Denied a service token lacking ${REQUIRED_ROLE}`);
      throw new ForbiddenException('Token lacks the required service role');
    }

    return true;
  }
}
