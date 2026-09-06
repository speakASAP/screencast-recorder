import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Written by hand rather than generated, so the reviewed SQL is exactly what
 * runs. Creates the three capture tables in an empty database; no other
 * service reads this schema, so the down path is a plain drop.
 */
export class InitialSchema1757200000000 implements MigrationInterface {
  name = 'InitialSchema1757200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // No CREATE EXTENSION here. `screencast_app` is a least-privilege role and
    // cannot install pgcrypto, which is correct -- the fix is to not need it.
    // TypeORM's @PrimaryGeneratedColumn('uuid') generates the value in the
    // application, so no database-side gen_random_uuid() default is required.
    await queryRunner.query(`
      CREATE TABLE "agents" (
        "id" uuid NOT NULL,
        "hostname" text NOT NULL,
        "machineId" text NOT NULL,
        "platform" text NOT NULL,
        "agentVersion" text,
        "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "lastSeenAt" timestamptz,
        "enrolledAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agents" PRIMARY KEY ("id")
      )
    `);

    // Enrolment is idempotent on this pair: an agent restart must not create a
    // second row, or the operator sees the same machine listed twice.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_agents_host_machine" ON "agents" ("hostname", "machineId")
    `);

    await queryRunner.query(`
      CREATE TABLE "sessions" (
        "id" uuid NOT NULL,
        "title" text NOT NULL,
        "state" text NOT NULL DEFAULT 'preparing',
        "t0" timestamptz,
        "startedAt" timestamptz,
        "endedAt" timestamptz,
        "clockOffsetMs" integer,
        "s3Prefix" text,
        "retentionPolicy" text NOT NULL DEFAULT 'retain-until-published',
        "failureReason" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sessions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_sessions_state" ON "sessions" ("state")
    `);

    await queryRunner.query(`
      CREATE TABLE "tracks" (
        "id" uuid NOT NULL,
        "sessionId" uuid NOT NULL,
        "agentId" uuid NOT NULL,
        "kind" text NOT NULL,
        "sourceRef" text NOT NULL,
        "codec" text,
        "fps" integer,
        "segmentCount" integer NOT NULL DEFAULT 0,
        "bytes" bigint NOT NULL DEFAULT 0,
        "degraded" boolean NOT NULL DEFAULT false,
        "uploadState" text NOT NULL DEFAULT 'pending',
        CONSTRAINT "PK_tracks" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tracks_session" FOREIGN KEY ("sessionId")
          REFERENCES "sessions"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_tracks_session" ON "tracks" ("sessionId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "tracks"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
    await queryRunner.query(`DROP TABLE "agents"`);
  }
}
