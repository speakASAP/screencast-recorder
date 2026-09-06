import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-agent timing manifests, stored verbatim.
 *
 * jsonb rather than normalised columns: this document is the contract a later
 * editing stage reads, and its timing cannot be reconstructed from the media,
 * so it is kept exactly as the agent sent it.
 */
export class Manifests1757200200000 implements MigrationInterface {
  name = 'Manifests1757200200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "manifests" (
        "id" uuid NOT NULL,
        "sessionId" uuid NOT NULL,
        "agentId" uuid NOT NULL,
        "document" jsonb NOT NULL,
        "receivedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_manifests" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_manifests_session" ON "manifests" ("sessionId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "manifests"`);
  }
}
