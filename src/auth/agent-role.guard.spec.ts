import { ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AgentRoleGuard } from './agent-role.guard';
import { TokenValidator } from './token-validator';

const ctx = (headers: Record<string, string>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    getHandler: () => ({}),
    getClass: () => ({ name: 'TestController' }),
  }) as unknown as ExecutionContext;

const reflectorReturning = (value: unknown): Reflector =>
  ({ getAllAndOverride: () => value }) as unknown as Reflector;

describe('AgentRoleGuard', () => {
  let validator: { validate: jest.Mock };
  let logger: { error: jest.Mock };

  beforeEach(() => {
    validator = { validate: jest.fn() };
    logger = { error: jest.fn() };
  });

  const guardWith = (declared: unknown): AgentRoleGuard =>
    new AgentRoleGuard(
      reflectorReturning(declared),
      validator as unknown as TokenValidator,
      logger as unknown as Logger,
    );

  it('denies an undecorated route even when the token is valid', async () => {
    // A role claim that is not enforced is not an authorization boundary. An
    // undecorated machine route is a defect, so it fails closed and is logged.
    validator.validate.mockResolvedValue({ roles: ['internal:screencast-recorder:agent'] });
    await expect(guardWith(undefined).canActivate(ctx({ authorization: 'Bearer good' }))).rejects.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });

  it('denies a token that carries some other service role', async () => {
    validator.validate.mockResolvedValue({ roles: ['internal:other-service:admin'] });
    await expect(guardWith(true).canActivate(ctx({ authorization: 'Bearer wrong' }))).rejects.toThrow();
  });

  it('denies a token carrying no roles at all', async () => {
    validator.validate.mockResolvedValue({ roles: [] });
    await expect(guardWith(true).canActivate(ctx({ authorization: 'Bearer none' }))).rejects.toThrow();
  });

  it('allows the correct pair role', async () => {
    validator.validate.mockResolvedValue({ roles: ['internal:screencast-recorder:agent'] });
    await expect(guardWith(true).canActivate(ctx({ authorization: 'Bearer good' }))).resolves.toBe(true);
  });

  it('denies a missing Authorization header', async () => {
    await expect(guardWith(true).canActivate(ctx({}))).rejects.toThrow();
    expect(validator.validate).not.toHaveBeenCalled();
  });

  it('denies a non-Bearer Authorization header', async () => {
    await expect(guardWith(true).canActivate(ctx({ authorization: 'Basic abc' }))).rejects.toThrow();
    expect(validator.validate).not.toHaveBeenCalled();
  });

  it('never puts the token into a log line', async () => {
    validator.validate.mockResolvedValue({ roles: ['internal:other:admin'] });
    await guardWith(true).canActivate(ctx({ authorization: 'Bearer SUPERSECRETTOKEN' })).catch(() => undefined);
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain('SUPERSECRETTOKEN');
  });
});
