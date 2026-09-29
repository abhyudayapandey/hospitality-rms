import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

// Table types are added here as migrations introduce tables.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Database {}

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(connectionString: string): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
}

/**
 * Runs `fn` in a transaction with `app.user_id` set for the duration of that
 * transaction only, so RLS (via core.current_user_id()) sees the caller.
 * Every request from the app goes through this.
 */
export async function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.user_id', ${userId}, true)`.execute(tx);
    return fn(tx);
  });
}

export { sql } from 'kysely';
