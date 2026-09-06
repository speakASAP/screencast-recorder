import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Agent } from '../sessions/entities/agent.entity';
import { Command } from '../sessions/entities/command.entity';
import { Session } from '../sessions/entities/session.entity';
import { Track } from '../sessions/entities/track.entity';

/**
 * Shared by the running app and the TypeORM CLI.
 *
 * `synchronize` is never enabled. Schema changes go through a reviewed
 * migration applied with `migration:run`; letting the ORM diff a live database
 * at boot is how a column gets dropped during a rollout.
 */
export const dataSourceOptions = {
  type: 'postgres' as const,
  host: process.env.DB_HOST ?? 'db-server-postgres',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'screencast',
  username: process.env.DB_USER ?? 'screencast_app',
  password: process.env.DB_PASSWORD ?? '',
  entities: [Agent, Command, Session, Track],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
  logging: ['error', 'warn'] as ('error' | 'warn')[],
};

export default new DataSource(dataSourceOptions);
