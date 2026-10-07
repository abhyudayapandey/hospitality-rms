import { LEVELS, TILES } from '@outlet-ops/domain';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCustomer } from './apply';
import {
  emptyDraft,
  filesFromDraft,
  readDraft,
  roleQuestions,
  type SetupDraft,
} from './setup-draft';

// The set-up wizard (ADR 064): a new customer set up from nothing, for every kind of outlet
// with everything it offers, goes live through the real loader with no issues: a person in
// each role, one role covered by the outlet's manager and one not done, par on the stock.
// The covering manager holds the covered role's access there; a second load changes nothing.

afterAll(closePools);
vi.setConfig({ testTimeout: 600_000 });

function draftFor(tile: string, offers: readonly string[]): SetupDraft {
  const d = emptyDraft();
  const code = `WIZ-${tile.toUpperCase().replace(/_/g, '-')}`;
  d.company = {
    ...d.company,
    name: `Wizard ${tile}`,
    code,
    isTest: true,
    ownerName: 'Asha Rao',
    ownerEmail: `${code.toLowerCase()}@example.test`,
  };
  d.outlets.push({
    ...readDraft({ outlets: [{ key: 'o1', tile, extras: offers }] }).outlets[0]!,
    name: 'First',
    area: 'Mumbai',
    location: '19.0596, 72.8295',
  });
  const o = d.outlets[0]!;
  const qs = roleQuestions(d, o);
  const manager = qs.find((q) => q.level === 'runs_outlet');
  const head = qs.find((q) => q.code !== manager?.code && q.level === 'runs_department');
  if (manager && head) o.roles[head.code] = { mode: 'covered_by', by: manager.code };
  const idle = qs.filter((q) => q.level === 'works').at(-1);
  if (idle && qs.filter((q) => q.level === 'works').length > 1) {
    o.roles[idle.code] = { mode: 'not_done' };
  }
  for (const q of qs) {
    if (o.roles[q.code]) continue;
    d.people.push({ name: `${q.title} One`, email: '', role: q.code, outlet: 'o1' });
  }
  d.people.push({ name: 'Hema Admin', email: 'hema@example.test', role: 'HR_ADMIN', outlet: '' });
  for (const item of Object.keys(o.stock)) o.stock[item] = { off: false, par: '5' };
  return d;
}

async function groupsOf(c: PoolClient, tenant: string, title: string) {
  const { rows } = await c.query<{ g: string }>(
    `select distinct g.code g from core.role_assignment ra
       join core.security_group g on g.id = ra.group_id
       join core.app_user u on u.id = ra.user_id
      where u.tenant_id = $1 and u.display_name = $2
        and (ra.effective_to is null or ra.effective_to >= current_date) order by 1`,
    [tenant, title],
  );
  return rows.map((r) => r.g);
}

describe('a customer from the set-up wizard', () => {
  it('every kind of outlet goes live with people, cover and stock', async () => {
    let covers = 0;
    await inRolledBackTx(async (c) => {
      for (const tile of TILES) {
        await c.query('savepoint tile');
        const d = draftFor(tile.code, tile.offers);
        const files = filesFromDraft(d);
        const r = await loadCustomer(c, files, { nested: true });
        expect(r.issues, tile.code).toEqual([]);
        const again = await loadCustomer(c, files, { nested: true });
        for (const [entity, n] of Object.entries(again.counts)) {
          expect(n.created + n.updated, `${tile.code}: ${entity}`).toBe(0);
        }
        // every person has a role assignment at the outlet (or the company)
        const { rows: none } = await c.query<{ display_name: string }>(
          `select u.display_name from core.app_user u
            where u.tenant_id = $1 and u.kind = 'human'
              and not exists (select 1 from core.role_assignment ra where ra.user_id = u.id)`,
          [r.tenantId],
        );
        expect(none, tile.code).toEqual([]);
        // the manager covering a department head holds what the head would hold
        const o = d.outlets[0]!;
        const cover = Object.entries(o.roles).find(([, a]) => a.mode === 'covered_by');
        if (cover) {
          covers++;
          const qs = roleQuestions(d, o);
          const by = qs.find((q) => q.code === (cover[1] as { by: string }).by)!;
          const covered = qs.find((q) => q.code === cover[0])!;
          expect(LEVELS.indexOf(covered.level)).toBeGreaterThanOrEqual(
            LEVELS.indexOf('runs_department'),
          );
          const { rows: held } = await c.query<{ n: number }>(
            `select count(*)::int n from hr.role_cover rc
               join core.hierarchy_node n on n.id = rc.org_node_id
              where n.tenant_id = $1 and rc.job_role_code = $2 and rc.archived_at is null`,
            [r.tenantId, covered.code],
          );
          expect(held[0]!.n, tile.code).toBe(1);
          const theirs = await groupsOf(c, r.tenantId!, `${by.title} One`);
          const { rows: wanted } = await c.query<{ g: string }>(
            `select distinct d.access_group g
               from core.hierarchy_node o
               cross join lateral core.derive_job_role_access_at(o.tenant_id, $2, o.id) d
              where o.tenant_id = $1 and o.kind = 'outlet' and d.error is null`,
            [r.tenantId, covered.code],
          );
          for (const w of wanted) expect(theirs, `${tile.code}: ${w.g}`).toContain(w.g);
        }
        await c.query('rollback to savepoint tile');
      }
    });
    expect(covers).toBeGreaterThanOrEqual(4);
  });
});
