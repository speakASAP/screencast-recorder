import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export interface ServiceClaims {
  email?: string;
  roles?: string[];
  type?: string;
}

/**
 * Validates a service JWT through auth-microservice.
 *
 * The token is never logged, never echoed into an exception message, and never
 * decoded locally for authorization: the canonical service identity standard
 * requires validation through Auth, not self-inspection of an unverified
 * payload.
 */
@Injectable()
export class TokenValidator {
  private readonly logger = new Logger(TokenValidator.name);

  private readonly authUrl = process.env.AUTH_SERVICE_URL ?? 'http://auth-microservice:3370';

  async validate(token: string): Promise<ServiceClaims | null> {
    let response: Response;
    try {
      response = await fetch(`${this.authUrl}/auth/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      // Never include the request body or headers here; both carry the token.
      this.logger.error(`Auth validation transport failure: ${(error as Error).name}`);
      throw new ServiceUnavailableException('Identity provider unreachable');
    }

    if (!response.ok) {
      this.logger.warn(`Auth rejected a service token with status ${response.status}`);
      return null;
    }

    const body = (await response.json()) as { user?: ServiceClaims } & ServiceClaims;
    return body.user ?? body;
  }
}
