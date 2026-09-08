import 'reflect-metadata';
import { Controller, Get, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { UnauthorizedRedirectFilter } from './unauthorized-redirect.filter';

/**
 * Exercises Nest's own filter DISPATCH, not the filter's body.
 *
 * The unit spec calls filter.catch() directly, which bypasses @Catch()
 * entirely -- so it passed identically whether or not the filter was
 * registered for ServiceUnavailableException. That made it useless as
 * evidence for this change: a green run proved nothing about the behaviour
 * the operator actually sees. These tests go through the HTTP layer, so they
 * fail if @Catch() stops listing ServiceUnavailableException.
 */
@Controller()
class ProbeController {
  @Get('console')
  console(): string {
    throw new ServiceUnavailableException('Identity provider unreachable');
  }

  @Get('expired')
  expired(): string {
    throw new UnauthorizedException('Session expired');
  }
}

describe('UnauthorizedRedirectFilter dispatch', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new UnauthorizedRedirectFilter());
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  const navigate = (path: string) =>
    fetch(`${url}${path}`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });

  it('redirects a browser to sign in when Auth is unreachable', async () => {
    const response = await navigate('/console');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/auth/login?next=%2Fconsole');
  });

  it('still redirects a browser whose session expired', async () => {
    const response = await navigate('/expired');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/auth/login?next=%2Fexpired');
  });

  it('leaves a fetch() caller with the 503 status, not a redirect', async () => {
    const response = await fetch(`${url}/console`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ message: 'Identity provider unreachable' });
  });
});
