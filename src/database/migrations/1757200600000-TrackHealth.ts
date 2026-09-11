import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Written by hand rather than generated: this repo has no
 * `migration:generate` script, and generating one would diff entities
 * against a live database this change does not have.
 *
 * Adds per-track capture health, reported by the agent alongside segments and
 * bytes. A track's ffmpeg can stay alive while writing nothing -- `degraded`
 * only flips on process exit, so it cannot see that case. Additive and safe:
 * a new text column with a database-side default, applied to every existing
 * row by the ALTER itself, so no separate backfill or data rewrite is needed.
 */
export class TrackHealth1757200600000 implements MigrationInterface {
  name = 'TrackHealth1757200600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tracks" ADD COLUMN "health" text NOT NULL DEFAULT 'ok'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tracks" DROP COLUMN "health"`);
  }
}
