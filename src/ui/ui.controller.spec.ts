import { AgentsService } from '../agents/agents.service';
import { UiController } from './ui.controller';

const agentsReturning = (agents: unknown[]) =>
  ({ listAll: jest.fn(async () => agents) }) as unknown as AgentsService;

describe('UiController.sources', () => {
  it('builds the source list from reported capabilities, never from constants', async () => {
    // A hardcoded display list is wrong on the next machine, and wrong on this
    // one as soon as a monitor is unplugged.
    const controller = new UiController(
      agentsReturning([
        {
          id: 'a',
          hostname: 'alfares',
          lastSeenAt: new Date(),
          capabilities: {
            displays: [{ id: 'HDMI-A-0', width: 3840, height: 2160 }],
            audio_inputs: [{ id: 'jabra', label: 'Jabra Link 390' }],
            cameras: [],
          },
        },
      ]),
    );

    const view = await controller.agentsView();
    expect(view[0].sources.map((s) => s.id)).toEqual(['HDMI-A-0', 'jabra']);
    expect(view[0].sources[0].kind).toBe('screen');
    expect(view[0].sources[1].kind).toBe('audio');
  });

  it('marks an absent camera unavailable rather than omitting or erroring', async () => {
    // The verified state of this host. The operator should see why the option
    // is off, not wonder whether the feature is broken.
    const controller = new UiController(
      agentsReturning([
        {
          id: 'a',
          hostname: 'alfares',
          lastSeenAt: new Date(),
          capabilities: { displays: [], audio_inputs: [], cameras: [] },
        },
      ]),
    );

    const view = await controller.agentsView();
    const webcam = view[0].unavailable.find((u) => u.kind === 'webcam');
    expect(webcam?.reason).toBe('no camera detected');
  });

  it('labels a display with its resolution so two monitors are distinguishable', async () => {
    const controller = new UiController(
      agentsReturning([
        {
          id: 'a',
          hostname: 'alfares',
          lastSeenAt: new Date(),
          capabilities: {
            displays: [
              { id: 'HDMI-A-0', width: 3840, height: 2160 },
              { id: 'DP-1', width: 1920, height: 1080 },
            ],
            audio_inputs: [],
            cameras: [],
          },
        },
      ]),
    );

    const view = await controller.agentsView();
    expect(view[0].sources[0].label).toContain('3840x2160');
    expect(view[0].sources[1].label).toContain('1920x1080');
  });

  it('reports an agent offline when its last heartbeat is stale', async () => {
    // Offering Start on a dead agent produces a session that never begins.
    const controller = new UiController(
      agentsReturning([
        {
          id: 'a',
          hostname: 'alfares',
          lastSeenAt: new Date(Date.now() - 10 * 60_000),
          capabilities: { displays: [], audio_inputs: [], cameras: [] },
        },
      ]),
    );

    expect((await controller.agentsView())[0].online).toBe(false);
  });

  it('treats an agent that has never reported as offline with no sources', async () => {
    const controller = new UiController(
      agentsReturning([{ id: 'a', hostname: 'new', lastSeenAt: null, capabilities: {} }]),
    );

    const view = await controller.agentsView();
    expect(view[0].online).toBe(false);
    expect(view[0].sources).toEqual([]);
  });
});
