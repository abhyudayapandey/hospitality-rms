import { describe, expect, it } from 'vitest';
import { NIGHTLY_JOBS, runJobs, TASKS_TICK_JOBS, type Queryable } from './ticks';

// The timed jobs' runner (ADR 167, H10 and L28): each job, and each customer's part of one, in
// its own transaction; a failure is rolled back and logged, and the rest still run and commit.

function fakeClient(breaks: (sql: string, params: unknown[]) => boolean) {
  const calls: string[] = [];
  const client: Queryable = {
    query: <R extends object>(text: string, params: unknown[] = []) => {
      if (text === 'select tenant_id, code from ops.tick_tenants()') {
        return Promise.resolve({
          rows: [
            { tenant_id: 't-a', code: 'A' },
            { tenant_id: 't-b', code: 'B' },
            { tenant_id: 't-c', code: 'C' },
          ] as unknown as R[],
        });
      }
      calls.push(params.length > 1 ? `${text} [${String(params[1])}]` : text);
      if (breaks(text, params)) return Promise.reject(new Error('a bad template'));
      return Promise.resolve({ rows: [{ created: 1 }] as unknown as R[] });
    },
  };
  return { client, calls };
}

describe('runJobs', () => {
  it("runs every job for every customer; one customer's failure stops only their part", async () => {
    const { client, calls } = fakeClient(
      (sql, params) => sql.includes('ops.tasks_tick') && params[1] === 't-b',
    );
    const logged: string[] = [];
    const r = await runJobs(client, TASKS_TICK_JOBS, { log: (m) => logged.push(m) });
    expect(r.failed).toEqual([{ job: 'tasks', tenant: 'B', error: 'a bad template' }]);
    expect(logged).toEqual(['[tasks] failed for B: a bad template']);
    // every job ran for every customer, B's tasks included (and rolled back)
    for (const job of [
      'wf.approvals_tick',
      'ops.tasks_tick',
      'ops.expiry_alerts',
      'ops.compliance_tick',
    ]) {
      for (const t of ['t-a', 't-b', 't-c']) {
        expect(calls.some((c) => c.includes(job) && c.endsWith(`[${t}]`))).toBe(true);
      }
    }
    expect(Object.keys(r.done)).toContain('tasks A');
    expect(Object.keys(r.done)).toContain('tasks C');
    expect(Object.keys(r.done)).not.toContain('tasks B');
    // each unit is its own transaction: begin, the actor, the job, then commit or rollback
    const b = calls.findIndex((c) => c.includes('ops.tasks_tick') && c.endsWith('[t-b]'));
    expect(calls.slice(b - 2, b + 2)).toEqual([
      'begin',
      `select set_config('app.actor_kind', 'executor', true)`,
      calls[b],
      'rollback',
    ]);
    expect(calls.filter((c) => c === 'commit')).toHaveLength(11);
    expect(calls.filter((c) => c === 'rollback')).toHaveLength(1);
  });

  it('runs every nightly step even when one fails', async () => {
    const { client, calls } = fakeClient((sql) => sql.includes('hr.nightly_attendance'));
    const r = await runJobs(client, NIGHTLY_JOBS);
    expect(r.failed.map((f) => f.job)).toEqual(['attendance']);
    expect(calls.some((c) => c.includes('hr.purge_personnel'))).toBe(true);
    expect(calls.some((c) => c.includes('ops.purge_task_photos'))).toBe(true);
    expect(calls.some((c) => c.includes('audit.keep_partitions'))).toBe(true);
    expect(r.done['audit partitions']).toEqual({ created: 1 });
  });
});
