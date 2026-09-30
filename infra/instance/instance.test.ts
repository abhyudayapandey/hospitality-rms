import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static checks on what runs on the instance. These guard the security properties the
// stack tests cannot see: DB bound to localhost only, per-service credential isolation,
// and no production role grants to migrator.

const dir = import.meta.dirname;
const read = (p: string) => readFileSync(join(dir, p), 'utf8');

const scripts = [
  'user-data.sh',
  ...readdirSync(join(dir, 'deploy'))
    .filter((f) => f.endsWith('.sh'))
    .map((f) => join('deploy', f)),
];

const loadCredentials = (unit: string) =>
  read(join('systemd', unit))
    .split('\n')
    .filter((l) => l.startsWith('LoadCredential='))
    .map((l) => l.slice('LoadCredential='.length));

describe('instance scripts', () => {
  it.each(scripts)('%s is valid bash', (script) => {
    expect(() => execFileSync('bash', ['-n', join(dir, script)])).not.toThrow();
  });

  // lib.sh is sourced by the others and inherits their options.
  it.each(scripts.filter((s) => !s.endsWith('lib.sh')))('%s fails fast', (script) => {
    expect(read(script)).toMatch(/^set -eu(x?)o pipefail$/m);
  });
});

describe('postgres is never reachable from outside the instance', () => {
  it('listens on 127.0.0.1 only', () => {
    const conf = read('postgres/postgresql.conf');
    const listen = conf.split('\n').filter((l) => /^\s*listen_addresses\s*=/.test(l));
    expect(listen).toEqual(["listen_addresses = '127.0.0.1'"]);
  });

  it('pg_hba allows only local peer for postgres and loopback scram', () => {
    const rules = read('postgres/pg_hba.conf')
      .split('\n')
      .map((l) => l.trim().replace(/\s+/g, ' '))
      .filter((l) => l && !l.startsWith('#'));
    expect(rules).toEqual(['local all postgres peer', 'host all all 127.0.0.1/32 scram-sha-256']);
  });

  it('container uses host networking and publishes no ports', () => {
    const up = read('deploy/postgres-up.sh');
    expect(up).toContain('--network host');
    expect(up).not.toMatch(/\s(-p|--publish)\s/);
  });
});

describe('per-service credential isolation', () => {
  it('web gets only app_rw and the session secret', () => {
    expect(loadCredentials('outlet-ops-web.service')).toEqual([
      'db_app_rw:/etc/outlet-ops/creds/app_rw',
      'session_secret:/etc/outlet-ops/creds/session_secret',
    ]);
  });

  it('wf-execute gets only wf_executor', () => {
    expect(loadCredentials('outlet-ops-wf-execute.service')).toEqual([
      'db_wf_executor:/etc/outlet-ops/creds/wf_executor',
    ]);
  });

  it('the nightly attendance job gets only wf_executor', () => {
    expect(loadCredentials('outlet-ops-attendance-nightly.service')).toEqual([
      'db_wf_executor:/etc/outlet-ops/creds/wf_executor',
    ]);
  });

  it('the platform worker gets only platform_loader, and nothing else does (ADR 012)', () => {
    expect(loadCredentials('outlet-ops-platform-worker.service')).toEqual([
      'db_platform_loader:/etc/outlet-ops/creds/platform_loader',
    ]);
    for (const unit of readdirSync(join(dir, 'systemd')).filter(
      (f) => f !== 'outlet-ops-platform-worker.service',
    )) {
      expect(read(join('systemd', unit)), unit).not.toContain('platform_loader');
    }
    const env = read('deploy/fetch-params.sh');
    expect(env.slice(env.indexOf('web.env'), env.indexOf('caddy.env'))).not.toContain(
      'platform_loader',
    );
  });

  it('services run as their own unprivileged users', () => {
    expect(read('systemd/outlet-ops-platform-worker.service')).toMatch(
      /^User=outletops-platform$/m,
    );
    expect(read('systemd/outlet-ops-web.service')).toMatch(/^User=outletops-web$/m);
    expect(read('systemd/outlet-ops-wf-execute.service')).toMatch(/^User=outletops-wf$/m);
    expect(read('systemd/outlet-ops-attendance-nightly.service')).toMatch(/^User=outletops-wf$/m);
  });
});

describe('scheduled jobs', () => {
  it('runs the attendance job nightly in India time, catching up after downtime', () => {
    const timer = read('systemd/outlet-ops-attendance-nightly.timer');
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 02:15:00 Asia\/Kolkata$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
  });

  it('deploy enables and starts every timer it ships', () => {
    const deploy = read('deploy/deploy.sh');
    for (const t of readdirSync(join(dir, 'systemd')).filter((f) => f.endsWith('.timer'))) {
      expect(deploy.match(new RegExp(t.replace('.', '\\.'), 'g'))?.length).toBe(2);
    }
  });

  it('the release bundles every job a unit runs', () => {
    const build = read('../scripts/build-release.sh');
    expect(read('deploy/platform-worker.sh')).toContain('jobs/platform-worker.mjs');
    expect(build).toContain('--outfile="$OUT/jobs/platform-worker.mjs"');
    expect(read('deploy/deploy.sh')).toMatch(/enable[^;]*outlet-ops-platform-worker\.service/);
    for (const script of ['wf-execute', 'attendance-nightly']) {
      expect(read(`deploy/${script}.sh`)).toContain(`jobs/${script}.mjs`);
      expect(build).toMatch(new RegExp(`:${script}[ ;]`));
    }
  });
});

describe('web environment', () => {
  it('gives the web app the photo bucket and region for presigned URLs (no credentials)', () => {
    const script = read('deploy/fetch-params.sh');
    const env = script.slice(script.indexOf('web.env'), script.indexOf('caddy.env'));
    expect(env).toContain('PHOTO_BUCKET=${cfg[photo_bucket]}');
    expect(env).toContain('AWS_REGION=');
    expect(env).not.toMatch(/AWS_ACCESS_KEY|AWS_SECRET|PASSWORD|SECRET/);
    expect(script).toMatch(/for key in [^;]*photo_bucket/);
  });
});

describe('database bootstrap', () => {
  const sql = read('deploy/bootstrap-db.sh');

  it('never grants app_rw or wf_executor to migrator in production', () => {
    expect(sql).not.toMatch(/grant\s+(app_rw|wf_executor)[\s\S]*?\bto\s+migrator/i);
    expect(sql).toMatch(/revoke app_rw, wf_executor, platform_loader from migrator;/);
  });

  it('no application role is superuser or bypasses RLS', () => {
    for (const role of ['migrator', 'app_rw', 'wf_executor']) {
      expect(sql).toMatch(new RegExp(`alter role ${role} with [^;]*nosuperuser[^;]*nobypassrls`));
    }
  });

  it('platform_loader: not superuser, no role or database creation; bypasses RLS by design', () => {
    expect(sql).toMatch(
      /alter role platform_loader with login nosuperuser nocreaterole nocreatedb bypassrls/,
    );
    expect(sql).toMatch(/revoke app_rw, wf_executor, platform_loader from migrator;/);
    expect(sql).not.toMatch(/grant\s+[^;]*platform_loader[^;]*\bto\s+migrator/i);
  });
});
