import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

interface Entry {
  token: string;
  expiresAt: number;
}

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
 * In-memory is deliberate for a single-replica, single-operator service: a
 * restart signs the operator out, which is a mild annoyance rather than data
 * loss, and it keeps the token out of the database. A second replica would
 * need Redis, and that is the moment to add it, not before.
 */
@Injectable()
export class SessionStore {
  private readonly sessions = new Map<string, Entry>();

  create(token: string, ttlMs: number): string {
    this.sweep();
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { token, expiresAt: Date.now() + ttlMs });
    return id;
  }

  get(id: string): string | null {
    const entry = this.sessions.get(id);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return entry.token;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  /** Drops expired entries so an abandoned browser cannot grow the map forever. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (entry.expiresAt <= now) this.sessions.delete(id);
    }
  }
}
