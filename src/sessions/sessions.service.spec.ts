import { SessionState } from './entities/session.entity';
import { SessionsService } from './sessions.service';

type Row = Record<string, unknown>;

/**
 * A small in-memory stand-in for the three repositories. The barrier logic is
 * what these tests are about; exercising it through a real database would test
 * TypeORM instead.
 */
function makeService(opts: { agents: string[]; state?: SessionState }) {
  const session: Row = {
    id: 's1',
    state: opts.state ?? SessionState.Preparing,
    t0: null,
    startedAt: null,
    endedAt: null,
    failureReason: null,
    clockOffsetMs: null,
  };
  const tracks: Row[] = opts.agents.map((agentId, i) => ({
    id: `t${i}`,
    sessionId: 's1',
    agentId,
    kind: 'screen',
  }));
  const commands: Row[] = [];

  const sessionsRepo = {
    findOne: jest.fn(async () => session),
    save: jest.fn(async (s: Row) => Object.assign(session, s)),
    create: jest.fn((s: Row) => s),
    find: jest.fn(async () => [session]),
  };
  const tracksRepo = {
    find: jest.fn(async () => tracks),
    save: jest.fn(async (t: unknown) => t),
    create: jest.fn((t: Row) => t),
  };
  const commandsService = {
    queue: jest.fn(async (agentId: string, type: string, sessionId: string, payload: unknown) => {
      commands.push({ agentId, type, sessionId, payload });
    }),
    queued: () => commands,
  };

  const service = new SessionsService(
    sessionsRepo as never,
    tracksRepo as never,
    commandsService as never,
  );

  return { service, session, commands, commandsService };
}

describe('the readiness barrier', () => {
  it('does not issue start until every agent reports ready', async () => {
    const { service, commands } = makeService({ agents: ['a', 'b'] });

    await service.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    expect(commands.filter((c) => c.type === 'start')).toHaveLength(0);

    await service.reportStatus('s1', { agent_id: 'b', state: 'ready' } as never);
    expect(commands.filter((c) => c.type === 'start')).toHaveLength(2);
  });

  it('issues start to nobody when one agent fails', async () => {
    const { service, session, commands } = makeService({ agents: ['a', 'b'] });

    await service.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    await service.reportStatus('s1', {
      agent_id: 'b',
      state: 'failed',
      reason: 'clock_unsynchronised',
    } as never);

    // A partial start would produce tracks that cannot be aligned afterwards.
    expect(commands.filter((c) => c.type === 'start')).toHaveLength(0);
    expect(session.state).toBe(SessionState.Failed);
    expect(session.failureReason).toContain('clock_unsynchronised');
  });

  it('sets t0 far enough ahead for the command to arrive', async () => {
    const { service, session } = makeService({ agents: ['a'] });
    const before = Date.now();

    await service.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);

    // Agents schedule against t0 rather than starting on arrival, so it must
    // be far enough ahead that the long poll can deliver it first.
    expect((session.t0 as Date).getTime()).toBeGreaterThan(before + 1000);
  });

  it('records the worst clock offset reported by any agent', async () => {
    const { service, session } = makeService({ agents: ['a', 'b'] });
    await service.reportStatus('s1', {
      agent_id: 'a', state: 'ready', clock: { synchronised: true, offset_ms: 2 },
    } as never);
    await service.reportStatus('s1', {
      agent_id: 'b', state: 'ready', clock: { synchronised: true, offset_ms: 9 },
    } as never);
    // The editor needs the largest skew to know its alignment tolerance.
    expect(session.clockOffsetMs).toBe(9);
  });

  it('ignores a duplicate ready from the same agent', async () => {
    const { service, commands } = makeService({ agents: ['a', 'b'] });
    await service.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    await service.reportStatus('s1', { agent_id: 'a', state: 'ready' } as never);
    // Two reports from one agent must not satisfy a two-agent barrier.
    expect(commands.filter((c) => c.type === 'start')).toHaveLength(0);
  });
});

describe('state transitions', () => {
  it('refuses to save straight from recording, skipping review', async () => {
    const { service } = makeService({ agents: ['a'], state: SessionState.Recording });
    await expect(service.save('s1')).rejects.toThrow();
  });

  it('allows save from review', async () => {
    const { service, session } = makeService({ agents: ['a'], state: SessionState.Review });
    await service.save('s1');
    expect(session.state).toBe(SessionState.Uploading);
  });

  it('allows discard from review and uploads nothing', async () => {
    const { service, session, commands } = makeService({ agents: ['a'], state: SessionState.Review });
    await service.discard('s1');
    expect(session.state).toBe(SessionState.Discarded);
    expect(commands.filter((c) => c.type === 'upload')).toHaveLength(0);
  });

  it('refuses to reopen a stored session', async () => {
    const { service } = makeService({ agents: ['a'], state: SessionState.Stored });
    await expect(service.save('s1')).rejects.toThrow();
  });
});
