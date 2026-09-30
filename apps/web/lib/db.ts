import 'server-only';
import { createDb, sql, withUser as dbWithUser, type Db, type Tx } from '@outlet-ops/db';

// The web app's only path to Postgres (CLAUDE.md AWS overrides): every request runs
// inside withUser(userId, fn) as app_rw, so RLS and the RPCs see the caller.

const globalForDb = globalThis as unknown as { __ooDb?: Db };

function db(): Db {
  if (!globalForDb.__ooDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    globalForDb.__ooDb = createDb(url);
  }
  return globalForDb.__ooDb;
}

export function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return dbWithUser(db(), userId, fn);
}

/**
 * Before sign-in only: resolves a verified Cognito sub to a user. Runs as app_rw with no
 * app.user_id, so it can do nothing but call core.user_for_cognito_sub.
 */
export async function userIdForCognitoSub(sub: string): Promise<string | null> {
  return db()
    .transaction()
    .execute(async (tx) => {
      const r = await sql<{
        id: string | null;
      }>`select core.user_for_cognito_sub(${sub}) as id`.execute(tx);
      return r.rows[0]?.id ?? null;
    });
}

/**
 * Rate limits (ADR 011): counts one hit on `key` and says whether it is within the limit.
 * Runs as app_rw with no app.user_id; core.rate_limit_hit is all it can call.
 */
export async function rateLimitHit(key: string, limit: number, windowS: number): Promise<boolean> {
  return db()
    .transaction()
    .execute(async (tx) => {
      const r = await sql<{
        ok: boolean;
      }>`select core.rate_limit_hit(${key}, ${limit}::int, ${windowS}::int) as ok`.execute(tx);
      return r.rows[0]?.ok === true;
    });
}

/** Dev login only (ADR 004): resolves a test user by customer code and username. */
export async function userIdForUsername(
  customer: string,
  username: string,
): Promise<string | null> {
  return db()
    .transaction()
    .execute(async (tx) => {
      const r = await sql<{
        id: string | null;
      }>`select core.user_for_username(${customer}, ${username}) as id`.execute(tx);
      return r.rows[0]?.id ?? null;
    });
}

export { sql, type Tx };
