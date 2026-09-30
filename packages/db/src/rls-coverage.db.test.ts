import { afterAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx, migratorPool } from '../test/helpers';

// CLAUDE.md rules 1 and 5: every table in hr, inv, ops, wf, ai has RLS with
// generated policies only, is registered to a domain, and has the audit trigger.

afterAll(closePools);

type Violation = { table_name: string; problem: string };

describe('RLS coverage', () => {
  it('has no business table without RLS, generated policies and audit', async () => {
    const { rows } = await migratorPool.query<Violation>('select * from core.rls_violations()');
    expect(rows).toEqual([]);
  });

  it('detects a table with no RLS (so the check above can fail)', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('create table hr.zz_naked (id uuid primary key, org_node_id uuid)');
      const { rows } = await c.query<Violation>(
        `select * from core.rls_violations() where table_name = 'hr.zz_naked' order by problem`,
      );
      expect(rows.map((r) => r.problem)).toEqual([
        'no_audit_trigger',
        'no_generated_policies',
        'not_registered',
        'rls_disabled',
      ]);
    });
  });

  it('detects hand-written policies', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('create table wf.zz_hand (id uuid primary key, org_node_id uuid)');
      await c.query('alter table wf.zz_hand enable row level security');
      await c.query('create policy anyone on wf.zz_hand for select using (true)');
      const { rows } = await c.query<Violation>(
        `select * from core.rls_violations() where table_name = 'wf.zz_hand'`,
      );
      expect(rows.map((r) => r.problem)).toContain('hand_written_policy');
    });
  });

  it('checks audit.log has RLS enabled', async () => {
    const { rows } = await migratorPool.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'audit.log'::regclass`,
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
  });

  it('audits every core table', async () => {
    // core.rate_limit only holds sign-in and reset counters (ADR 011): auditing it would
    // write an audit row per attempt and record nothing about access or data
    const { rows } = await migratorPool.query<{ table_name: string }>(
      `select c.oid::regclass::text as table_name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'core' and c.relkind in ('r', 'p') and not c.relispartition
          and c.oid <> 'core.rate_limit'::regclass
          and not exists (
            select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
             where t.tgrelid = c.oid and p.oid = 'audit.capture'::regproc)
        order by 1`,
    );
    expect(rows).toEqual([]);
  });
});

describe('extensions and search_path', () => {
  it('keeps ltree in schema extensions, not public', async () => {
    const { rows } = await migratorPool.query<{ nspname: string }>(
      `select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
        where e.extname = 'ltree'`,
    );
    expect(rows).toEqual([{ nspname: 'extensions' }]);
  });

  it('pins search_path on every SECURITY DEFINER function, without public', async () => {
    const { rows } = await migratorPool.query<{ fn: string; config: string[] | null }>(
      `select p.oid::regprocedure::text as fn, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname in ('core', 'audit', 'hr', 'inv', 'ops', 'wf', 'ai')
        order by 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const sp = (r.config ?? []).find((c) => c.startsWith('search_path='));
      expect(sp, r.fn).toBeDefined();
      expect(sp, r.fn).not.toMatch(/\bpublic\b/);
    }
    const can = rows.find((r) => r.fn.startsWith('core.can('));
    expect(can?.config).toContain('search_path=pg_catalog, core, extensions');
  });
});

describe('DB roles', () => {
  it('app_rw and wf_executor cannot bypass RLS or own tables', async () => {
    const { rows } = await migratorPool.query<{
      rolname: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
      owned: string;
    }>(
      `select r.rolname, r.rolbypassrls, r.rolsuper,
              (select count(*) from pg_class c where c.relowner = r.oid) as owned
         from pg_roles r where r.rolname in ('migrator', 'app_rw', 'wf_executor')
        order by r.rolname`,
    );
    expect(rows.map((r) => r.rolname)).toEqual(['app_rw', 'migrator', 'wf_executor']);
    for (const r of rows) {
      expect(r.rolbypassrls).toBe(false);
      expect(r.rolsuper).toBe(false);
    }
    expect(rows.find((r) => r.rolname === 'app_rw')?.owned).toBe('0');
    expect(rows.find((r) => r.rolname === 'wf_executor')?.owned).toBe('0');
  });
});
