// The timed jobs (ADR 167, review H10 and L28): each job, and each customer's part of a job, runs
// in its own transaction as the executor. One that fails is logged with its job and customer
// and rolled back; the rest still run and commit. The caller exits non-zero when anything
// failed, so the timer's unit shows it.

/** The little of pg.Client the jobs need, so the runner can be tested without a database. */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface Job {
  /** Shown in the log. */
  name: string;
  /**
   * The SQL. A per-customer job takes $1 = the time (null: the database's now) and $2 = the
   * customer; a whole job takes $1 if it uses it.
   */
  sql: string;
  perTenant: boolean;
}

export interface JobFailure {
  job: string;
  tenant: string | null;
  error: string;
}

export interface JobsResult {
  /** Each unit's first row, by "job" or "job tenant-code". */
  done: Record<string, Record<string, unknown> | undefined>;
  failed: JobFailure[];
}

export interface JobsOptions {
  now?: Date;
  log?: (msg: string) => void;
}

/** One unit of work in its own transaction, as the executor. */
async function unit(
  client: Queryable,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown> | undefined> {
  await client.query('begin');
  try {
    await client.query(`select set_config('app.actor_kind', 'executor', true)`);
    const { rows } = await client.query(sql, params);
    await client.query('commit');
    return rows[0];
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}

export async function runJobs(
  client: Queryable,
  jobs: readonly Job[],
  opts: JobsOptions = {},
): Promise<JobsResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? null;
  const result: JobsResult = { done: {}, failed: [] };
  let tenants: { tenant_id: string; code: string | null }[] | null = null;
  for (const job of jobs) {
    if (!job.perTenant) {
      try {
        result.done[job.name] = await unit(client, job.sql, job.sql.includes('$1') ? [now] : []);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        result.failed.push({ job: job.name, tenant: null, error });
        log(`[${job.name}] failed: ${error}`);
      }
      continue;
    }
    if (!tenants) {
      try {
        tenants = (
          await client.query<{ tenant_id: string; code: string | null }>(
            'select tenant_id, code from ops.tick_tenants()',
          )
        ).rows;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        result.failed.push({ job: 'customers', tenant: null, error });
        log(`[customers] failed: ${error}`);
        tenants = [];
      }
    }
    for (const t of tenants) {
      const key = `${job.name} ${t.code ?? t.tenant_id}`;
      try {
        result.done[key] = await unit(client, job.sql, [now, t.tenant_id]);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        result.failed.push({ job: job.name, tenant: t.code ?? t.tenant_id, error });
        log(`[${job.name}] failed for ${t.code ?? t.tenant_id}: ${error}`);
      }
    }
  }
  return result;
}

const at = 'coalesce($1::timestamptz, now())';

/** The tasks tick, every 5 minutes (ADR 020, 040, 069; approvals ADR 167). */
export const TASKS_TICK_JOBS: readonly Job[] = [
  { name: 'approvals', sql: `select * from wf.approvals_tick(${at}, $2)`, perTenant: true },
  { name: 'tasks', sql: `select * from ops.tasks_tick(${at}, $2)`, perTenant: true },
  { name: 'expiry', sql: `select ops.expiry_alerts(${at}, $2) as sent`, perTenant: true },
  { name: 'compliance', sql: `select * from ops.compliance_tick(${at}, $2)`, perTenant: true },
];

/** The nightly job (ADR 008, 045, 079, 023; the audit log's partitions ADR 167). */
export const NIGHTLY_JOBS: readonly Job[] = [
  {
    name: 'attendance',
    sql: `select * from hr.nightly_attendance(${at})`,
    perTenant: false,
  },
  { name: 'personnel', sql: `select hr.purge_personnel(${at}) as n`, perTenant: false },
  { name: 'task photos', sql: `select ops.purge_task_photos(${at}) as n`, perTenant: false },
  {
    name: 'audit partitions',
    sql: 'select audit.keep_partitions(3) as n',
    perTenant: false,
  },
];

/** The report tables (ADR 023): after the night's exceptions, and alone for --reports-only. */
export const REPORT_JOBS: readonly Job[] = [
  { name: 'reports', sql: 'select rpt.nightly() as n', perTenant: false },
];
