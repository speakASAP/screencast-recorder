import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Written by hand rather than generated: this repo has no
 * `migration:generate` script, and generating one would diff entities against
 * a live database this change does not have.
 *
 * Splits delivery from acknowledgement. `deliveredAt` alone used to mean both
 * "handed out" and "done", so an agent that died between receiving a command
 * and acting on it never saw that command again -- a pending `stop` was lost
 * and its session sat in `stopping` for ever.
 *
 * Additive and safe. Both columns have database-side defaults applied by the
 * ALTER itself, so no backfill is needed, but the existing rows need one
 * deliberate decision: every command already delivered before this migration
 * is treated as acknowledged. The alternative -- leaving them unacknowledged --
 * would have the API redeliver the entire history of past sessions to the
 * agent the moment it next polls.
 *
 * The old `(agentId, deliveredAt)` index is replaced rather than kept: the
 * long-poll predicate is now `(agentId, acknowledgedAt IS NULL)`, and it runs
 * twice a second per agent.
 */
export class CommandAcknowledgement1757200700000 implements MigrationInterface {
  name = 'CommandAcknowledgement1757200700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "commands" ADD COLUMN "acknowledgedAt" timestamptz`);
    await queryRunner.query(
      `ALTER TABLE "commands" ADD COLUMN "deliveryCount" integer NOT NULL DEFAULT 0`,
    );

    // Retire the pre-existing queue: anything already handed out was acted on
    // by an agent that had no way to acknowledge it.
    await queryRunner.query(
      `UPDATE "commands" SET "acknowledgedAt" = "deliveredAt", "deliveryCount" = 1
       WHERE "deliveredAt" IS NOT NULL`,
    );

    // Name verified against the live database rather than assumed: the index
    // is `IDX_commands_agent_undelivered`, created by the Commands migration.
    // A wrong name here would leave the stale index in place under an
    // `IF EXISTS` that silently matched nothing.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_commands_agent_undelivered"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_commands_agent_unacknowledged"
       ON "commands" ("agentId", "acknowledgedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_commands_agent_unacknowledged"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_commands_agent_undelivered"
       ON "commands" ("agentId", "deliveredAt")`,
    );
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "deliveryCount"`);
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "acknowledgedAt"`);
  }
}
