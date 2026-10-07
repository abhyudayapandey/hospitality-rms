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
export async function withUser<T>(
  db: Db,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: { presentedBy?: string } = {},
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.user_id', ${userId}, true)`.execute(tx);
    // shown as this person by a demo presenter (ADR 071): the database checks it may be
    if (opts.presentedBy) await sql`select core.presented_by(${opts.presentedBy})`.execute(tx);
    return fn(tx);
  });
}

/**
 * A platform admin request (ADR 012): `app.platform_admin_id` is set and `app.user_id`
 * cleared, so core.current_user_id() is null and no customer data is visible; platform
 * functions check the admin themselves.
 */
export async function withPlatformAdmin<T>(
  db: Db,
  adminId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.platform_admin_id', ${adminId}, true),
                     set_config('app.user_id', '', true)`.execute(tx);
    return fn(tx);
  });
}

export { sql } from 'kysely';
