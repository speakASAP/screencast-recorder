import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('agents')
@Index(['hostname', 'machineId'], { unique: true })
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  hostname!: string;

  /** From /etc/machine-id: stable across reboots, so re-enrolment is idempotent. */
  @Column({ type: 'text' })
  machineId!: string;

  @Column({ type: 'text' })
  platform!: string;

  @Column({ type: 'text', nullable: true })
  agentVersion!: string | null;

  /**
   * Replaced wholesale at every agent startup, never merged. Hardware changes
   * between runs -- a camera is plugged in, a monitor is unplugged -- and a
   * merged view would keep offering a source that no longer exists.
   */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  capabilities!: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  enrolledAt!: Date;
}
