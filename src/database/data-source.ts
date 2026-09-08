import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Agent } from '../sessions/entities/agent.entity';
import { Command } from '../sessions/entities/command.entity';
import { Manifest } from '../sessions/entities/manifest.entity';
import { Session } from '../sessions/entities/session.entity';
import { Track } from '../sessions/entities/track.entity';
import { SessionPreview } from '../preview/session-preview.entity';

/**
 * Shared by the running app and the TypeORM CLI.
 *
 * `synchronize` is never enabled. Schema changes go through a reviewed
 * migration; letting the ORM diff a live database at boot is how a column
 * gets dropped during a rollout.
 *
 * `migrationsRun` IS enabled, and the distinction matters: a migration is a
 * reviewed, ordered, forward-only script, while synchronize is the ORM
 * guessing. Without this the pod boots against whatever schema happens to be
 * there and the mismatch surfaces as a runtime query error on the first
 * request that touches the new column -- which is exactly what happened to
 * `session_previews`: two migrations were written, neither ran at boot, and
 * the table existed only because it had been applied by hand.
 */
export const dataSourceOptions = {
  type: 'postgres' as const,
  host: process.env.DB_HOST ?? 'db-server-postgres',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'screencast',
  username: process.env.DB_USER ?? 'screencast_app',
  password: process.env.DB_PASSWORD ?? '',
  entities: [Agent, Command, Manifest, Session, Track, SessionPreview],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
  migrationsRun: true,
  logging: ['error', 'warn'] as ('error' | 'warn')[],
};

export default new DataSource(dataSourceOptions);
