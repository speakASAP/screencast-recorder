import { randomUUID } from 'node:crypto';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One agent's timing manifest for one session.
 *
 * Stored verbatim as sent. This is the contract a later editing stage reads,
 * and the timing it carries -- per-segment ranges, PTS origin, measured clock
 * offset -- cannot be reconstructed from the media afterwards, so it is kept
 * whole rather than normalised into columns.
 */
@Entity('manifests')
@Index(['sessionId'])
export class Manifest {
  @PrimaryColumn({ type: 'uuid' })
  id: string = randomUUID();

  @Column({ type: 'uuid' })
  sessionId!: string;

  @Column({ type: 'uuid' })
  agentId!: string;

  @Column({ type: 'jsonb' })
  document!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt!: Date;
}
