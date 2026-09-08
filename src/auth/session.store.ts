import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { AuthSession } from './auth-session.entity';

/**
 * Server-side session store: the cookie carries a short opaque id, never the
 * token itself.
 *
 * The token cannot live in the cookie. This operator's Auth token is ~4085
 * bytes because the account holds 83 roles, and once the cookie name, Max-Age,
 * Expires, Path and flags are added the Set-Cookie header passes the 4096-byte
 * limit, so browsers and curl drop it silently -- the login appears to succeed
 * and the next request is unauthenticated.
 *
 * Rows live in Postgres, not in a Map. The cookie survives a pod restart, so
 * the session it names has to as well: with an in-memory store every deploy
 * left browsers holding an id the server no longer knew, and each reload
 * answered with a 401 the operator could not clear. Persisting also means a
 * second replica is a configuration change rather than a rewrite.
 */
@Injectable()
export class SessionStore {
  constructor(
    @InjectRepository(AuthSession)
    private readonly sessions: Repository<AuthSession>,
  ) {}

  async create(token: string, ttlMs: number): Promise<string> {
    await this.sweep();
    const id = randomBytes(32).toString('base64url');
    await this.sessions.save({ id, token, expiresAt: new Date(Date.now() + ttlMs) });
    return id;
  }

  async get(id: string): Promise<string | null> {
    const entry = await this.sessions.findOne({ where: { id } });
    if (!entry) return null;

    // Checked here as well as swept: a row that outlived its ttl but has not
    // been swept yet must not authenticate.
    if (entry.expiresAt.getTime() <= Date.now()) {
      await this.destroy(id);
      return null;
    }
    return entry.token;
  }

  async destroy(id: string): Promise<void> {
    await this.sessions.delete(id);
  }

  /** Drops expired rows so an abandoned browser cannot grow the table forever. */
  private async sweep(): Promise<void> {
    await this.sessions.delete({ expiresAt: LessThanOrEqual(new Date()) });
  }
}
