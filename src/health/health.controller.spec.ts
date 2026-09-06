import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok with the service name', () => {
    expect(new HealthController().check()).toEqual({
      status: 'ok',
      service: 'screencast-recorder',
    });
  });
});
