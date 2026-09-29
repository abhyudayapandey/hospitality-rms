import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, withUser } from './index';

const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => db.destroy());

describe('baseline migration', () => {
  it('has the ltree extension', async () => {
    const { rows } = await sql<{
      extname: string;
    }>`select extname from pg_extension where extname = 'ltree'`.execute(db);
    expect(rows).toHaveLength(1);
  });

  it('creates the business schemas with usage for app_rw', async () => {
    const { rows } = await sql<{ nspname: string; usable: boolean }>`
      select nspname, has_schema_privilege(nspname, 'usage') as usable
      from pg_namespace
      where nspname in ('core', 'hr', 'inv', 'ops', 'wf', 'ai', 'audit')
      order by nspname`.execute(db);
    expect(rows.map((r) => r.nspname)).toEqual(['ai', 'audit', 'core', 'hr', 'inv', 'ops', 'wf']);
    expect(rows.every((r) => r.usable)).toBe(true);
  });

  it('connects as app_rw without BYPASSRLS', async () => {
    const { rows } = await sql<{ rolname: string; rolbypassrls: boolean }>`
      select rolname, rolbypassrls from pg_roles where rolname = current_user`.execute(db);
    expect(rows[0]).toEqual({ rolname: 'app_rw', rolbypassrls: false });
  });
});

describe('withUser', () => {
  const userId = '0192f0c0-0000-7000-8000-000000000001';

  it('sets app.user_id inside the transaction', async () => {
    const value = await withUser(db, userId, async (tx) => {
      const { rows } = await sql<{
        v: string;
      }>`select current_setting('app.user_id', true) as v`.execute(tx);
      return rows[0]?.v;
    });
    expect(value).toBe(userId);
  });

  it('does not leak app.user_id outside the transaction', async () => {
    await withUser(db, userId, () => Promise.resolve());
    const { rows } = await sql<{
      v: string | null;
    }>`select nullif(current_setting('app.user_id', true), '') as v`.execute(db);
    expect(rows[0]?.v).toBeNull();
  });
});
