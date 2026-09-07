import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rendered preview proxies, one row per session.
 *
 * The rendered objects live in the `artifacts` jsonb rather than in columns,
 * because a session has one video proxy and a variable number of audio
 * proxies -- one per capture source -- and that set is what completeness is
 * checked against.
 *
 * No foreign key cascade delete is declared here beyond the session link,
 * and nothing in the preview subsystem deletes rows or objects.
 */
export class SessionPreview1757200300000 implements MigrationInterface {
  name = 'SessionPreview1757200300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "session_previews" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "sessionId" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
        "state" text NOT NULL DEFAULT 'pending',
        "artifacts" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "sourcePath" text,
        "failureReason" text,
        "requestedAt" timestamptz NOT NULL DEFAULT now(),
        "readyAt" timestamptz
      )
    `);
    // One preview per session; a repeat request reuses the row.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_session_previews_session"
      ON "session_previews" ("sessionId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_session_previews_session"`);
    await queryRunner.query(`DROP TABLE "session_previews"`);
  }
}
