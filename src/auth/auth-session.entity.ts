import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One signed-in operator session: the opaque cookie id and the token it stands for.
 *
 * This lives in the database rather than in process memory because the cookie
 * outlives the pod. An in-memory Map meant every restart -- every deploy --
 * invalidated every session while browsers kept presenting the same id, and
 * the console answered each reload with a bare 401 that no amount of
 * reloading could clear.
 *
 * The token itself is stored, not a hash: it must be replayed to Auth on
 * every request to validate. That is the same exposure the cookie already
 * carried, moved from memory to a database the service alone can read.
 */
@Entity('auth_sessions')
export class AuthSession {
  /** The opaque id handed to the browser; never the token. */
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  token!: string;

  /**
   * Indexed because the sweep deletes by expiry, and that query runs on every
   * sign-in.
   */
  @Index('IDX_auth_sessions_expires')
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
