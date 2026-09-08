import { AGENT_ROUTE } from '../auth/agent-roles.decorator';
import { PUBLIC_ROUTE } from '../auth/public.decorator';
import { PreviewAgentController } from './preview-agent.controller';

describe('PreviewAgentController lane', () => {
  it('is an agent route, and not a public one', () => {
    // The other half of the lane assertion: PreviewController must carry no
    // @AgentRoute(), and this one must carry it. Without this test the
    // callback could silently lose its guard and fall through to the global
    // UserAuthGuard, which the agent cannot satisfy -- every render would
    // finish and never be recorded.
    const handler = PreviewAgentController.prototype.previewComplete;
    expect(Reflect.getMetadata(AGENT_ROUTE, handler)).toBe(true);
    expect(Reflect.getMetadata(PUBLIC_ROUTE, handler)).toBeUndefined();
  });
});

describe('PreviewAgentController.previewComplete', () => {
  it('passes the report straight through to the service', async () => {
    const preview = { completeRender: jest.fn().mockResolvedValue(undefined) };
    const controller = new PreviewAgentController(preview as never);
    const dto = { agent_id: 'a1', state: 'ready' as const, artifacts: [] };
    await controller.previewComplete('s1', dto as never);
    expect(preview.completeRender).toHaveBeenCalledWith('s1', dto);
  });
});
