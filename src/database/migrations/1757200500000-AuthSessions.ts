import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Operator sessions, moved out of process memory.
 *
 * The session cookie lives in the browser for 12 hours, but the store behind
 * it was a Map, so every pod restart -- every deploy -- threw away every
 * session while browsers kept presenting the same ids. The guard answered
 * each one with a 401 rendered as JSON, and because nothing cleared the dead
 * cookie, reloading reproduced it forever.
 *
 * No foreign key: a session names an Auth identity, not a row in this
 * database, and the token is validated against Auth on every request.
 */
export class AuthSessions1757200500000 implements MigrationInterface {
  name = 'AuthSessions1757200500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "auth_sessions" (
        "id" text PRIMARY KEY,
        "token" text NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    // The sweep deletes by expiry on every sign-in.
    await queryRunner.query(`
      CREATE INDEX "IDX_auth_sessions_expires"
      ON "auth_sessions" ("expiresAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_auth_sessions_expires"`);
    await queryRunner.query(`DROP TABLE "auth_sessions"`);
  }
}
