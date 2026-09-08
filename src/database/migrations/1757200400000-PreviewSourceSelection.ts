import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remembers which audio source the operator chose to listen to.
 *
 * Nullable with no backfill: null means "no choice made", which the console
 * renders as the automatic pick. Defaulting it to the loudest source would
 * record a decision the operator never took, and the panel exists precisely
 * to keep those two apart.
 */
export class PreviewSourceSelection1757200400000 implements MigrationInterface {
  name = 'PreviewSourceSelection1757200400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_previews" ADD COLUMN "selectedSourceRef" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "session_previews" DROP COLUMN "selectedSourceRef"`,
    );
  }
}
