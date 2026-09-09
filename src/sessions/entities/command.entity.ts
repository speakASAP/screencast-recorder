import { randomUUID } from 'node:crypto';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export enum CommandType {
  Prepare = 'prepare',
  Start = 'start',
  Stop = 'stop',
  Abort = 'abort',
  Upload = 'upload',
  /**
   * Start or stop the process that feeds a phone's stream into a loopback
   * device, and report whether it is running.
   *
   * Outside the capture loop, like RenderPreview: it acts on the host's camera
   * plumbing rather than on a session, and the operator drives it from the
   * console before recording anything.
   */
  PullerControl = 'puller_control',
  /**
   * Render the preview proxies for a stored session.
   *
   * Unlike every other command here this one is not part of the capture loop:
   * it acts on a session that already finished and uploaded. The agent refuses
   * it while a recording is running, because a capture in flight holds the
   * only copy of media that cannot be re-recorded and must not compete with an
   * encoder for the GPU.
   */
  RenderPreview = 'render-preview',
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
