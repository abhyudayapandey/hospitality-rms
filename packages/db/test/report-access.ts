import type { PoolClient } from 'pg';
import { attemptAs } from './helpers';

// Shared by reports-access.db.test.ts and reports-refusals.db.test.ts: every person of both
// test customers, and a call made as one of them.

export interface Person {
  id: string;
  username: string;
  tenant: string;
  groups: string[];
  worker: boolean;
}

export async function everyone(c: PoolClient): Promise<Person[]> {
  const { rows } = await c.query<Person>(
    `select u.id, u.username, t.code as tenant,
            coalesce(array_agg(distinct g.code) filter (where g.code is not null), '{}') as groups,
            exists (select 1 from hr.worker w where w.owner_user_id = u.id and w.status = 'active')
              as worker
       from core.app_user u
       join core.tenant t on t.id = u.tenant_id
       left join core.role_assignment ra on ra.user_id = u.id
                                        and ra.effective_from <= current_date
                                        and (ra.effective_to is null or ra.effective_to >= current_date)
       left join core.security_group g on g.id = ra.group_id
      where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and u.kind = 'human'
        and u.status = 'active' and u.username is not null
      group by u.id, u.username, t.code
      order by u.username`,
  );
  return rows;
}

export async function as<T extends object>(
  c: PoolClient,
  user: string,
  sql: string,
  params: unknown[] = [],
) {
  return attemptAs<T>(c, user, sql, params);
}

export async function reportsOf(c: PoolClient, user: string): Promise<string[]> {
  const r = await as<{ report: string }>(c, user, 'select report from rpt.my_reports()');
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows.map((x) => x.report);
}

export async function placesOf(c: PoolClient, user: string, report: string): Promise<string[]> {
  const r = await as<{ code: string }>(c, user, 'select code from rpt.report_places($1)', [report]);
  if (r.error !== undefined) throw new Error(`${report}: ${r.error}`);
  return r.rows.map((x) => x.code).sort();
}
