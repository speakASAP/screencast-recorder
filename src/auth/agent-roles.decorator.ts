import { SetMetadata } from '@nestjs/common';

export const AGENT_ROUTE = 'agent_route';

/**
 * Marks a route as machine-accessible by the recording agent.
 *
 * AgentRoleGuard denies any route it protects that lacks this decorator, so
 * forgetting it fails closed rather than exposing the route.
 */
export const AgentRoute = (): MethodDecorator & ClassDecorator => SetMetadata(AGENT_ROUTE, true);
