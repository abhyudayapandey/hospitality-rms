import 'server-only';
import {
  createDb,
  sql,
  withPlatformAdmin as dbWithPlatformAdmin,
  withUser as dbWithUser,
  type Db,
  type Tx,
} from '@outlet-ops/db';
import { showAsClaim } from './auth/show-as';

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

export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // a demo presenter showing the app as this person (ADR 071): the database checks it
  const claim = await showAsClaim();
  return dbWithUser(
    db(),
    userId,
    fn,
    claim && claim.targetId === userId ? { presentedBy: claim.presenterId } : {},
  );
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

/** Platform console requests (ADR 012): no customer data is visible in them. */
export function withPlatformAdmin<T>(adminId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return dbWithPlatformAdmin(db(), adminId, fn);
}

/**
 * Platform sign-in only, after the platform pool's ID token was verified and its
 * cognito:groups includes platform-admins: records the admin and returns their id.
 */
export async function platformSignIn(sub: string, email: string): Promise<string> {
  return db()
    .transaction()
    .execute(async (tx) => {
      const r = await sql<{ id: string }>`select platform.sign_in(${sub}, ${email}) as id`.execute(
        tx,
      );
      return r.rows[0]!.id;
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
