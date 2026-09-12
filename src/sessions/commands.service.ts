import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, LessThanOrEqual, MoreThanOrEqual, Or, Repository } from 'typeorm';
import { Command, CommandType } from './entities/command.entity';

/** Long-poll window. Shorter than any sensible proxy timeout. */
const POLL_WINDOW_MS = 25_000;
const POLL_TICK_MS = 500;

/**
 * How long a handed-out command is considered in flight before it is offered
 * again.
 *
 * Just over the poll window, so an agent that receives a command and applies it
 * always acknowledges before its lease expires: a redelivery therefore means
 * the agent really died rather than that it was merely slow. A long-running
 * command (`render-preview`, `upload`) can overrun this and be redelivered
 * while it is still working, which the agent's durable applied-set absorbs by
 * ignoring the duplicate.
 */
export const LEASE_MS = 30_000;

/**
 * Deliveries after which a command is abandoned rather than offered again.
 *
 * Without a cap, a command that crashes the agent on arrival becomes a restart
 * loop that never surfaces anywhere. At the cap the session is failed instead,
 * so the operator sees one dead session rather than a machine cycling.
 */
export const ABANDON_AFTER_DELIVERIES = 3;

/** A command past the redelivery cap, for the caller that fails its session. */
export interface AbandonedCommand {
  commandId: string;
  sessionId: string;
  type: CommandType;
}

@Injectable()
export class CommandsService {
  constructor(
    @InjectRepository(Command)
    private readonly commands: Repository<Command>,
  ) {}

  async queue(
    agentId: string,
    type: CommandType,
    sessionId: string,
    payload: Record<string, unknown> = {},
  ): Promise<Command> {
    return this.commands.save(
      this.commands.create({
        agentId,
        sessionId,
        type,
        payload,
        deliveredAt: null,
        acknowledgedAt: null,
        deliveryCount: 0,
      }),
    );
  }

  /**
   * Hands the agent its oldest command that is neither acknowledged nor
   * currently in flight, waiting up to the poll window for one to appear.
   *
   * Delivery is at-least-once and acknowledgement is what retires a row. Before
   * this, `deliveredAt` was set on handout and also served as the done marker,
   * so an agent that died between receiving a command and acting on it never
   * saw that command again -- a pending `stop` was simply lost and its session
   * sat in `stopping` for ever. Redelivery only makes sense alongside the
   * agent's durable applied-set: an in-memory one is emptied by the very
   * restart that triggers the redelivery.
   */
  async nextFor(agentId: string, windowMs: number = POLL_WINDOW_MS): Promise<Command | null> {
    // `windowMs` exists for tests: the "hands out nothing" cases would
    // otherwise each wait out the real 25-second window.
    const deadline = Date.now() + windowMs;

    for (;;) {
      const pending = await this.commands.findOne({
        where: {
          agentId,
          acknowledgedAt: IsNull(),
          deliveryCount: LessThan(ABANDON_AFTER_DELIVERIES),
          // Never delivered, or delivered long enough ago that the agent
          // holding it is presumed dead.
          deliveredAt: Or(IsNull(), LessThanOrEqual(new Date(Date.now() - LEASE_MS))),
        },
        order: { issuedAt: 'ASC' },
      });

      if (pending) {
        pending.deliveredAt = new Date();
        pending.deliveryCount += 1;
        await this.commands.save(pending);
        return pending;
      }

      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, POLL_TICK_MS));
    }
  }

  /**
   * Records that the agent applied the command, retiring it from the queue.
   *
   * Scoped to the agent because the id arrives in the request path: an ack
   * misrouted to the wrong agent must not retire another machine's pending
   * command. Idempotent, so an ack retried after a lost response is harmless.
   */
  async acknowledge(agentId: string, commandId: string): Promise<void> {
    const command = await this.commands.findOne({ where: { id: commandId, agentId } });
    if (!command || command.acknowledgedAt) return;

    command.acknowledgedAt = new Date();
    await this.commands.save(command);
  }

  /**
   * Closes out an abandoned command so it is reported once and not on every
   * subsequent poll.
   *
   * Uses the acknowledgement column deliberately: the row is finished with
   * either way, and `deliveryCount` above the cap is what still distinguishes
   * "the agent applied this" from "we gave up on it".
   */
  async retire(commandId: string): Promise<void> {
    await this.commands.update({ id: commandId }, { acknowledgedAt: new Date() });
  }

  /**
   * Commands past the redelivery cap that were never acknowledged.
   *
   * Returned rather than acted on: failing a session belongs to
   * `SessionsService`, and this service is its dependency, not the other way
   * round.
   */
  async abandoned(agentId: string): Promise<AbandonedCommand[]> {
    const rows = await this.commands.find({
      where: {
        agentId,
        acknowledgedAt: IsNull(),
        deliveryCount: MoreThanOrEqual(ABANDON_AFTER_DELIVERIES),
      },
      order: { issuedAt: 'ASC' },
    });

    return rows.map((c) => ({ commandId: c.id, sessionId: c.sessionId, type: c.type }));
  }
}
