import { randomUUID } from 'node:crypto';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export enum CommandType {
  Prepare = 'prepare',
  Start = 'start',
  Stop = 'stop',
  Abort = 'abort',
  Upload = 'upload',
}

/**
 * A queued instruction for one agent.
 *
 * Persisted rather than held in memory: an API restart mid-session must not
 * lose a pending stop, and the agent's at-least-once redelivery check needs a
 * durable record of what was already handed out.
 */
@Entity('commands')
@Index(['agentId', 'deliveredAt'])
export class Command {
  @PrimaryColumn({ type: 'uuid' })
  id: string = randomUUID();

  @Column({ type: 'uuid' })
  agentId!: string;

  @Column({ type: 'uuid' })
  sessionId!: string;

  @Column({ type: 'text' })
  type!: CommandType;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  issuedAt!: Date;
}
