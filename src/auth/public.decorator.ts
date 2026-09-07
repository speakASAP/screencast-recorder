import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'public_route';

/**
 * Marks a route reachable without an operator session.
 *
 * Only three things qualify: the health endpoint that Kubernetes probes, and
 * the two login routes, which by definition run before a session exists.
 * Everything else is guarded, and a route that forgets the decorator fails
 * closed rather than open.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);
