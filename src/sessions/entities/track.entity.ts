import { randomUUID } from 'node:crypto';
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Session } from './session.entity';

export enum TrackKind {
  Screen = 'screen',
  Audio = 'audio',
  Webcam = 'webcam',
  Metadata = 'metadata',
}

export enum UploadState {
  Pending = 'pending',
  Uploading = 'uploading',
  Verified = 'verified',
  Failed = 'failed',
}

@Entity('tracks')
export class Track {
  @PrimaryColumn({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne(() => Session, (session) => session.tracks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  @Column({ type: 'uuid' })
  sessionId!: string;

  @Column({ type: 'uuid' })
  agentId!: string;

  @Column({ type: 'text' })
  kind!: TrackKind;

  /** Display id, PipeWire source name, or "activity" for the metadata stream. */
  @Column({ type: 'text' })
  sourceRef!: string;

  @Column({ type: 'text', nullable: true })
  codec!: string | null;

  @Column({ type: 'integer', nullable: true })
  fps!: number | null;

  @Column({ type: 'integer', default: 0 })
  segmentCount!: number;

  /**
   * bigint, and typed as string: a four-hour 4K session runs to tens of
   * billions of bytes, and node-postgres returns bigint as a string rather
   * than silently losing precision past 2^53.
   */
  @Column({ type: 'bigint', default: 0 })
  bytes!: string;

  /** Set when this track's capture died while the rest of the session continued. */
  @Column({ type: 'boolean', default: false })
  degraded!: boolean;

  @Column({ type: 'text', default: UploadState.Pending })
  uploadState!: UploadState;
}
