import { Repository } from 'typeorm';
import { Agent } from '../sessions/entities/agent.entity';
import { Command } from '../sessions/entities/command.entity';
import { AgentsService } from './agents.service';

describe('AgentsService', () => {
  let repo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    find: jest.Mock;
  };
  let commandRepo: { save: jest.Mock; create: jest.Mock };
  let service: AgentsService;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn((entity) => Promise.resolve({ id: 'new-uuid', ...entity })),
      create: jest.fn((entity) => entity),
      find: jest.fn(),
    };
    commandRepo = {
      save: jest.fn((entity) => Promise.resolve({ id: 'cmd-uuid', ...entity })),
      create: jest.fn((entity) => entity),
    };
    service = new AgentsService(
      repo as unknown as Repository<Agent>,
      commandRepo as unknown as Repository<Command>,
    );
  });

  const enrolment = {
    hostname: 'alfares',
    machine_id: 'abc123',
    platform: 'linux',
    agent_version: '0.1.0',
  };

  it('is idempotent on hostname and machineId', async () => {
    // Re-enrolment after an agent restart must not create a second row, or the
    // operator sees the same machine listed twice.
    repo.findOne.mockResolvedValue({ id: 'existing-uuid', hostname: 'alfares' });
    const result = await service.enroll(enrolment);
    expect(result.agent_id).toBe('existing-uuid');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('creates an agent on first contact', async () => {
    repo.findOne.mockResolvedValue(null);
    const result = await service.enroll(enrolment);
    expect(result.agent_id).toBe('new-uuid');
    expect(repo.create).toHaveBeenCalled();
  });

  it('returns a poll interval so the agent does not invent one', async () => {
    repo.findOne.mockResolvedValue({ id: 'x' });
    expect((await service.enroll(enrolment)).poll_interval_seconds).toBeGreaterThan(0);
  });

  it('replaces capabilities wholesale rather than merging', async () => {
    // A camera unplugged between runs must disappear from the source list, not
    // linger because an older report still mentions it.
    repo.findOne.mockResolvedValue({
      id: 'a',
      capabilities: { cameras: [{ id: '/dev/video0' }], displays: [] },
    });
    await service.reportCapabilities('a', {
      cameras: [],
      displays: [{ id: 'HDMI-A-0', width: 3840, height: 2160 }],
      audio_inputs: [],
    } as never);

    const saved = repo.save.mock.calls[0][0];
    expect(saved.capabilities.cameras).toEqual([]);
    expect(saved.capabilities.displays).toHaveLength(1);
  });

  it('stamps lastSeenAt when capabilities are reported', async () => {
    repo.findOne.mockResolvedValue({ id: 'a', capabilities: {} });
    await service.reportCapabilities('a', { displays: [] } as never);
    expect(repo.save.mock.calls[0][0].lastSeenAt).toBeInstanceOf(Date);
  });

  it('rejects a capability report for an unknown agent', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.reportCapabilities('ghost', { displays: [] } as never)).rejects.toThrow();
  });
});

describe('puller control', () => {
  const makeService = () => {
    const agents = {
      findOne: jest.fn(async (): Promise<{ id: string; hostname: string } | null> => ({
        id: 'a1',
        hostname: 'alfares',
      })),
      save: jest.fn(),
      create: jest.fn(),
      find: jest.fn(),
    };
    const commands = {
      save: jest.fn(async (entity) => entity),
      create: jest.fn((entity) => entity),
    };
    const service = new AgentsService(
      agents as unknown as Repository<Agent>,
      commands as unknown as Repository<Command>,
    );
    return { service, agents, commands };
  };

  it('queues a command the agent will pick up on its next poll', async () => {
    // The agent has no inbound HTTP surface, so control is queued rather than
    // called: this is the only path from the console to the puller.
    const { service, commands } = makeService();
    await service.queuePullerCommand('a1', 'start');

    expect(commands.save).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a1', payload: { action: 'start' } }),
    );
  });

  it('refuses an unknown agent rather than queueing an undeliverable command', async () => {
    const { service, agents } = makeService();
    agents.findOne = jest.fn(async () => null);
    await expect(service.queuePullerCommand('a1', 'start')).rejects.toThrow(/Unknown agent/);
  });

  it('reports no state before the agent has said anything', async () => {
    // "unknown" and "stopped" are different facts: one means the agent never
    // reported, the other that it reported a stopped puller.
    const { service } = makeService();
    expect(service.pullerStateFor('a1')).toBeNull();
  });

  it('keeps the last reported state per agent', async () => {
    const { service } = makeService();
    service.recordPullerState('a1', { running: true });
    expect(service.pullerStateFor('a1')).toMatchObject({ running: true });
  });
});
