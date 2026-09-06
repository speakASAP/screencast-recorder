import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Command, CommandType } from './entities/command.entity';

/** Long-poll window. Shorter than any sensible proxy timeout. */
const POLL_WINDOW_MS = 25_000;
const POLL_TICK_MS = 500;

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
      this.commands.create({ agentId, sessionId, type, payload, deliveredAt: null }),
    );
  }

  /**
   * Hands the agent its oldest undelivered command, waiting up to the poll
   * window for one to appear.
   *
   * Marking delivered here rather than on acknowledgement keeps the API simple
   * at the cost of at-least-once semantics: a response lost in flight is never
   * retried. The agent compensates by treating every command as idempotent on
   * command_id, which it must do anyway for its own crash recovery.
   */
  async nextFor(agentId: string): Promise<Command | null> {
    const deadline = Date.now() + POLL_WINDOW_MS;

    for (;;) {
      const pending = await this.commands.findOne({
        where: { agentId, deliveredAt: IsNull() },
        order: { issuedAt: 'ASC' },
      });

      if (pending) {
        pending.deliveredAt = new Date();
        await this.commands.save(pending);
        return pending;
      }

      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, POLL_TICK_MS));
    }
  }
}
