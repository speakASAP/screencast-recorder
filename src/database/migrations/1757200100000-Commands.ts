import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The agent command queue.
 *
 * Persisted rather than in-memory so an API restart mid-session does not lose a
 * pending stop, and so the agent's redelivery check has a durable record of
 * what was already handed out.
 */
export class Commands1757200100000 implements MigrationInterface {
  name = 'Commands1757200100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "commands" (
        "id" uuid NOT NULL,
        "agentId" uuid NOT NULL,
        "sessionId" uuid NOT NULL,
        "type" text NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "deliveredAt" timestamptz,
        "issuedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commands" PRIMARY KEY ("id")
      )
    `);

    // The long poll asks exactly one question: what is undelivered for this
    // agent, oldest first.
    await queryRunner.query(`
      CREATE INDEX "IDX_commands_agent_undelivered"
        ON "commands" ("agentId", "deliveredAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "commands"`);
  }
}
