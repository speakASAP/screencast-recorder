import { AGENT_ROUTE } from '../auth/agent-roles.decorator';
import { PUBLIC_ROUTE } from '../auth/public.decorator';
import { PreviewController } from './preview.controller';

describe('PreviewController lanes', () => {
  it('marks no preview route as an agent route or as public', () => {
    // Preview is the operator lane. An @AgentRoute() here would let the
    // machine credential read an operator's session; a @Public() would let
    // anyone. The global UserAuthGuard is the only thing that should cover it.
    const methods = ['status', 'requestRender', 'media', 'audio', 'timeline', 'selectSource'] as const;
    for (const method of methods) {
      const handler = PreviewController.prototype[method];
      expect(Reflect.getMetadata(AGENT_ROUTE, handler)).toBeUndefined();
      expect(Reflect.getMetadata(PUBLIC_ROUTE, handler)).toBeUndefined();
    }
    expect(Reflect.getMetadata(AGENT_ROUTE, PreviewController)).toBeUndefined();
    expect(Reflect.getMetadata(PUBLIC_ROUTE, PreviewController)).toBeUndefined();
  });
});

describe('PreviewController.media', () => {
  it('redirects to the presigned url rather than proxying the bytes', async () => {
    // The API is the control plane, not the video data path. A redirect also
    // lets the browser's Range requests reach MinIO directly, which is what
    // makes seeking a four-hour proxy work.
    const service = { videoUrl: jest.fn().mockResolvedValue('https://signed') };
    const controller = new PreviewController(service as never);
    const res = { redirect: jest.fn() };
    await controller.media('s1', res as never);
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://signed');
  });
});

describe('PreviewController.audio', () => {
  it('redirects to the presigned url for the named source', async () => {
    const service = { audioUrl: jest.fn().mockResolvedValue('https://signed-audio') };
    const controller = new PreviewController(service as never);
    const res = { redirect: jest.fn() };
    await controller.audio('s1', 'usb2', res as never);
    expect(service.audioUrl).toHaveBeenCalledWith('s1', 'usb2');
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://signed-audio');
  });
});

describe('PreviewController.timeline', () => {
  it('caps the bucket count so a request cannot ask for an unbounded response', async () => {
    const service = { timeline: jest.fn().mockResolvedValue({}) };
    const controller = new PreviewController(service as never);
    await controller.timeline('s1', '999999');
    expect(service.timeline).toHaveBeenCalledWith('s1', 5000);
  });

  it('falls back to a sensible default for a missing or nonsense bucket count', async () => {
    // Number('') is 0 and Number('abc') is NaN; both must land on the default
    // rather than producing a zero-bucket timeline.
    const service = { timeline: jest.fn().mockResolvedValue({}) };
    const controller = new PreviewController(service as never);
    await controller.timeline('s1', undefined);
    await controller.timeline('s1', 'abc');
    expect(service.timeline).toHaveBeenNthCalledWith(1, 's1', 1000);
    expect(service.timeline).toHaveBeenNthCalledWith(2, 's1', 1000);
  });
});
