import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Track } from './track.entity';

export enum SessionState {
  Preparing = 'preparing',
  Recording = 'recording',
  Stopping = 'stopping',
  Review = 'review',
  Uploading = 'uploading',
  Stored = 'stored',
  Discarded = 'discarded',
  Failed = 'failed',
}

/**
 * Transitions are enumerated rather than inferred from ordering, because the
 * review gate is a product requirement and not an incidental step: no session
 * may reach S3 without an explicit operator decision. An inferred "next state"
 * model would let a refactor quietly delete that gate.
 */
const LEGAL: Record<SessionState, SessionState[]> = {
  [SessionState.Preparing]: [SessionState.Recording, SessionState.Failed, SessionState.Discarded],
  [SessionState.Recording]: [SessionState.Stopping, SessionState.Failed],
  [SessionState.Stopping]: [SessionState.Review, SessionState.Failed],
  [SessionState.Review]: [SessionState.Uploading, SessionState.Discarded],
  [SessionState.Uploading]: [SessionState.Stored, SessionState.Failed],
  [SessionState.Stored]: [],
  [SessionState.Discarded]: [],
  [SessionState.Failed]: [],
};

export function isLegalTransition(from: SessionState, to: SessionState): boolean {
  return LEGAL[from].includes(to);
}

@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', default: SessionState.Preparing })
  state!: SessionState;

  /** The shared absolute instant every agent schedules its capture against. */
  @Column({ type: 'timestamptz', nullable: true })
  t0!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  /** Recorded so tracks from different machines can be aligned after the fact. */
  @Column({ type: 'integer', nullable: true })
  clockOffsetMs!: number | null;

  @Column({ type: 'text', nullable: true })
  s3Prefix!: string | null;

  @Column({ type: 'text', default: 'retain-until-published' })
  retentionPolicy!: string;

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany(() => Track, (track) => track.session)
  tracks!: Track[];
}
