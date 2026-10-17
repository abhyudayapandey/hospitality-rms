import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  asPlatform,
  closePools,
  inRolledBackTx,
  newPlatformAdmin,
  resetRole,
  sqlState,
} from '../test/helpers';

// Jobs on the server say when they last ran (ADR 170). The server's root scripts record each
// run (platform.job_ran, superuser only); /health asks platform.health() as app_rw, with no
// session, and gets only whether everything is fine and which jobs are late; the platform
// console lists them in words. A platform job left 'running' by a worker that died is taken
// up again after its lease, at most three tries in all.

afterAll(closePools);

async function late(c: PoolClient): Promise<string[]> {
  await c.query('set local role app_rw');
  try {
    return (await c.query<{ late: string[] }>('select late from platform.health()')).rows[0]!.late;
  } finally {
    await resetRole(c);
  }
}

describe('job heartbeats', () => {
  it('a job that ran recently is fine; one past its limit, or whose last run failed, is late', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`update platform.job_heartbeat set last_ok_at = now(), last_failed_at = null`);
      expect(await late(c)).toEqual([]);

      await c.query(
        `update platform.job_heartbeat set last_ok_at = now() - interval '8 hours'
          where job = 'pg-backup'`,
      );
      expect(await late(c)).toEqual(['pg-backup']);

      await c.query(`select platform.job_ran('pg-backup', true, null)`);
      await c.query(`select platform.job_ran('wf-execute', false, 'connection refused')`);
      expect(await late(c)).toEqual(['wf-execute']);

      // the next good run clears it, and keeps the last error for the console
      await c.query(`select platform.job_ran('wf-execute', true, null)`);
      expect(await late(c)).toEqual([]);
      const row = await c.query(
        `select last_error from platform.job_heartbeat where job = 'wf-execute'`,
      );
      expect(row.rows[0]).toEqual({ last_error: 'connection refused' });
    });
  });

  it('a job that never ran is late only once its limit has passed since it was listed', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`update platform.job_heartbeat set last_ok_at = now(), last_failed_at = null`);
      await c.query(
        `update platform.job_heartbeat set last_ok_at = null, created_at = now()
          where job = 'restore-drill'`,
      );
      expect(await late(c)).toEqual([]);
      await c.query(
        `update platform.job_heartbeat set created_at = now() - interval '9 days'
          where job = 'restore-drill'`,
      );
      expect(await late(c)).toEqual(['restore-drill']);
    });
  });

  it('every job a server unit runs is listed', async () => {
    await inRolledBackTx(async (c) => {
      const jobs = (await c.query<{ job: string }>('select job from platform.job_heartbeat')).rows;
      expect(jobs.map((j) => j.job).sort()).toEqual([
        'attendance-nightly',
        'os-patch',
        'pg-backup',
        'platform-worker',
        'restore-drill',
        'tasks-tick',
        'watchdog',
        'web',
        'wf-execute',
      ]);
    });
  });

  it('only the server (superuser) records runs; no app role can, or can read the table', async () => {
    await inRolledBackTx(async (c) => {
      for (const role of ['app_rw', 'wf_executor', 'platform_loader']) {
        for (const sql of [
          `select platform.job_ran('wf-execute', true, null)`,
          'select * from platform.job_heartbeat',
          `update platform.job_heartbeat set last_ok_at = now()`,
        ]) {
          await c.query(`set local role ${role}`);
          expect(await sqlState(c, sql), `${role}: ${sql}`).toBe('42501');
          await resetRole(c);
        }
      }
    });
  });

  it('health() tells app_rw only yes or no and the late jobs, with no session', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('set local role app_rw');
      const r = await c.query<Record<string, unknown>>('select * from platform.health()');
      await resetRole(c);
      expect(Object.keys(r.rows[0] ?? {}).sort()).toEqual(['late', 'ok']);
    });
  });

  it('the console lists every job in words, for platform admins only', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`update platform.job_heartbeat set last_ok_at = now(), last_failed_at = null`);
      await c.query(`select platform.job_ran('pg-backup', false, 'disk full')`);
      const admin = await newPlatformAdmin(c);
      const r = await asPlatform<{ label: string; late: boolean; last_error: string | null }>(
        c,
        admin,
        'select label, late, last_error from platform.job_status() order by label',
      );
      expect(r.error).toBeUndefined();
      expect(r.rows).toContainEqual({ label: 'Backups', late: true, last_error: 'disk full' });
      expect(r.rows!.filter((j) => j.late)).toHaveLength(1);

      await c.query('set local role app_rw');
      expect(await sqlState(c, 'select * from platform.job_status()')).toBe('P0001');
      await resetRole(c);
    });
  });
});

describe('a platform job whose worker died', () => {
  async function claim(c: PoolClient): Promise<{ id: string; attempts: number }[]> {
    await c.query('set local role platform_loader');
    try {
      return (
        await c.query<{ id: string; attempts: number }>(
          'select id, attempts from platform.claim_job()',
        )
      ).rows;
    } finally {
      await resetRole(c);
    }
  }

  async function runningJob(c: PoolClient, claimedAgo: string, attempts: number) {
    await c.query(`update platform.job set status = 'done' where status in ('queued', 'running')`);
    const r = await c.query<{ id: string }>(
      `insert into platform.job (kind, payload, status, attempts, claimed_at)
       values ('create_customer', '{}', 'running', $1, now() - $2::interval) returning id`,
      [attempts, claimedAgo],
    );
    return r.rows[0]!.id;
  }

  it('is taken up again after 30 minutes, not before', async () => {
    await inRolledBackTx(async (c) => {
      const job = await runningJob(c, '10 minutes', 1);
      expect(await claim(c)).toEqual([]);
      await c.query(
        `update platform.job set claimed_at = now() - interval '31 minutes' where id = $1`,
        [job],
      );
      expect(await claim(c)).toEqual([{ id: job, attempts: 2 }]);
    });
  });

  it('fails for good after its third try, in words, and is not run again', async () => {
    await inRolledBackTx(async (c) => {
      const job = await runningJob(c, '31 minutes', 3);
      expect(await claim(c)).toEqual([]);
      const r = await c.query(`select status, error from platform.job where id = $1`, [job]);
      expect(r.rows[0]).toEqual({
        status: 'failed',
        error: 'The worker stopped three times while running this. Start it again.',
      });
    });
  });

  it('a queued job is claimed as before', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `update platform.job set status = 'done' where status in ('queued', 'running')`,
      );
      const r = await c.query<{ id: string }>(
        `insert into platform.job (kind, payload) values ('create_customer', '{}') returning id`,
      );
      expect(await claim(c)).toEqual([{ id: r.rows[0]!.id, attempts: 1 }]);
    });
  });
});
