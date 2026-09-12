import { CommandType } from './entities/command.entity';
import { ABANDON_AFTER_DELIVERIES, CommandsService, LEASE_MS } from './commands.service';

type Row = Record<string, unknown>;

/**
 * In-memory stand-in for the commands repository, matching the house pattern in
 * `sessions.service.spec.ts`: the redelivery decision is what these tests are
 * about, and running them through a real database would test TypeORM instead.
 *
 * `findOne` reimplements only the two predicates the service actually uses --
 * equality on `agentId` and the delivery lease -- because the service passes a
 * TypeORM `where` object the fake cannot evaluate generically.
 */
function makeService(rows: Row[] = []) {
  const repo = {
    rows,
    create: jest.fn((c: Row) => ({ id: `c${rows.length + 1}`, deliveryCount: 0, ...c })),
    save: jest.fn(async (c: Row) => {
      const existing = rows.find((r) => r.id === c.id);
      if (existing) Object.assign(existing, c);
      else rows.push(c);
      return c;
    }),
    findOne: jest.fn(async ({ where }: { where: Row }) => {
      // `acknowledge` looks a row up by id; the long poll looks one up by
      // eligibility. Only the poll needs the lease predicates.
      if (where.id !== undefined) {
        return rows.find((r) => r.id === where.id && r.agentId === where.agentId) ?? null;
      }

      const now = Date.now();
      const eligible = rows
        .filter((r) => r.agentId === where.agentId)
        .filter((r) => !r.acknowledgedAt)
        .filter((r) => (r.deliveryCount as number) < ABANDON_AFTER_DELIVERIES)
        .filter((r) => {
          const delivered = r.deliveredAt as Date | null;
          return delivered === null || now - delivered.getTime() >= LEASE_MS;
        })
        .sort((a, b) => (a.issuedAt as Date).getTime() - (b.issuedAt as Date).getTime());
      return eligible[0] ?? null;
    }),
    update: jest.fn(async (where: Row, patch: Row) => {
      const target = rows.find((r) => r.id === where.id);
      if (target) Object.assign(target, patch);
      return { affected: target ? 1 : 0 };
    }),
    find: jest.fn(async ({ where }: { where: Row }) =>
      rows
        .filter((r) => r.agentId === where.agentId)
        .filter((r) => !r.acknowledgedAt)
        .filter((r) => (r.deliveryCount as number) >= ABANDON_AFTER_DELIVERIES)
        .sort((a, b) => (a.issuedAt as Date).getTime() - (b.issuedAt as Date).getTime()),
    ),
  };

  return { service: new CommandsService(repo as never), repo, rows };
}

function row(over: Row = {}): Row {
  return {
    id: 'c1',
    agentId: 'a1',
    sessionId: 's1',
    type: CommandType.Stop,
    payload: {},
    deliveredAt: null,
    acknowledgedAt: null,
    deliveryCount: 0,
    issuedAt: new Date('2026-09-12T10:00:00Z'),
    ...over,
  };
}

describe('handing out a command', () => {
  it('hands out an undelivered command and counts the delivery', async () => {
    const { service, rows } = makeService([row()]);

    const handed = await service.nextFor('a1');

    expect(handed?.id).toBe('c1');
    expect(rows[0].deliveryCount).toBe(1);
    expect(rows[0].deliveredAt).toBeInstanceOf(Date);
    expect(rows[0].acknowledgedAt).toBeNull();
  });

  it('does not hand out the same command again while the lease holds', async () => {
    // The agent has it and is working on it. A second poll inside the lease --
    // which a healthy agent makes every 25 seconds -- must not produce a
    // duplicate, or a redelivered `start` would spawn a second ffmpeg tree.
    const { service } = makeService([
      row({ deliveredAt: new Date(Date.now() - 1_000), deliveryCount: 1 }),
    ]);

    expect(await service.nextFor('a1', 0)).toBeNull();
  });

  it('hands out an unacknowledged command again once the lease expires', async () => {
    // The defect this protocol fixes: the agent died between receiving the
    // command and acting on it, so nothing acknowledged it and the session
    // would otherwise sit in its current phase for ever.
    const { service, rows } = makeService([
      row({ deliveredAt: new Date(Date.now() - LEASE_MS - 1), deliveryCount: 1 }),
    ]);

    const handed = await service.nextFor('a1');

    expect(handed?.id).toBe('c1');
    expect(rows[0].deliveryCount).toBe(2);
  });

  it('never hands out an acknowledged command', async () => {
    const { service } = makeService([
      row({
        deliveredAt: new Date(Date.now() - LEASE_MS - 1),
        acknowledgedAt: new Date(),
        deliveryCount: 1,
      }),
    ]);

    expect(await service.nextFor('a1', 0)).toBeNull();
  });

  it('hands out the oldest eligible command first', async () => {
    const { service } = makeService([
      row({ id: 'new', issuedAt: new Date('2026-09-12T10:05:00Z') }),
      row({ id: 'old', issuedAt: new Date('2026-09-12T10:00:00Z') }),
    ]);

    expect((await service.nextFor('a1'))?.id).toBe('old');
  });
});

describe('acknowledging a command', () => {
  it('marks the command acknowledged', async () => {
    const { service, rows } = makeService([row({ deliveredAt: new Date(), deliveryCount: 1 })]);

    await service.acknowledge('a1', 'c1');

    expect(rows[0].acknowledgedAt).toBeInstanceOf(Date);
  });

  it('ignores an acknowledgement from a different agent', async () => {
    // Agent ids come from the URL, so a misrouted ack must not retire another
    // machine's pending command.
    const { service, rows } = makeService([row({ deliveredAt: new Date(), deliveryCount: 1 })]);

    await service.acknowledge('someone-else', 'c1');

    expect(rows[0].acknowledgedAt).toBeNull();
  });

  it('is idempotent', async () => {
    const { service, rows } = makeService([row({ deliveredAt: new Date(), deliveryCount: 1 })]);

    await service.acknowledge('a1', 'c1');
    const first = rows[0].acknowledgedAt;
    await service.acknowledge('a1', 'c1');

    expect(rows[0].acknowledgedAt).toBe(first);
  });
});

describe('abandoning a command', () => {
  it('stops redelivering after the cap and names the session', async () => {
    // A command that kills the agent on arrival would otherwise be redelivered
    // for ever: crash, restart, poll, crash. The cap turns a silent restart
    // loop into one failed session the operator can see.
    const { service } = makeService([
      row({
        deliveredAt: new Date(Date.now() - LEASE_MS - 1),
        deliveryCount: ABANDON_AFTER_DELIVERIES,
      }),
    ]);

    expect(await service.nextFor('a1', 0)).toBeNull();
  });

  it('reports which sessions have a command past the cap', async () => {
    const { service } = makeService([
      row({ id: 'dead', deliveredAt: new Date(), deliveryCount: ABANDON_AFTER_DELIVERIES }),
      row({ id: 'live', deliveredAt: new Date(), deliveryCount: 1 }),
    ]);

    expect(await service.abandoned('a1')).toEqual([
      { commandId: 'dead', sessionId: 's1', type: CommandType.Stop },
    ]);
  });

  it('reports an abandoned command once, not on every poll', async () => {
    // The caller fails the session on the strength of this list. Reported
    // again on the next poll it would try to fail an already-failed session,
    // which the transition guard rejects as illegal.
    const { service } = makeService([
      row({ deliveredAt: new Date(), deliveryCount: ABANDON_AFTER_DELIVERIES }),
    ]);

    const [dead] = await service.abandoned('a1');
    await service.retire(dead.commandId);

    expect(await service.abandoned('a1')).toEqual([]);
  });

  it('does not report an abandoned command that was acknowledged late', async () => {
    const { service } = makeService([
      row({
        deliveredAt: new Date(),
        acknowledgedAt: new Date(),
        deliveryCount: ABANDON_AFTER_DELIVERIES,
      }),
    ]);

    expect(await service.abandoned('a1')).toEqual([]);
  });
});
