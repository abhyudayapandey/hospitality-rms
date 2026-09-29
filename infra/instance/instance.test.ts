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

  it('services run as their own unprivileged users', () => {
    expect(read('systemd/outlet-ops-web.service')).toMatch(/^User=outletops-web$/m);
    expect(read('systemd/outlet-ops-wf-execute.service')).toMatch(/^User=outletops-wf$/m);
  });
});

describe('database bootstrap', () => {
  const sql = read('deploy/bootstrap-db.sh');

  it('never grants app_rw or wf_executor to migrator in production', () => {
    expect(sql).not.toMatch(/grant\s+(app_rw|wf_executor)[\s\S]*?\bto\s+migrator/i);
    expect(sql).toMatch(/revoke app_rw, wf_executor from migrator;/);
  });

  it('no application role is superuser or bypasses RLS', () => {
    for (const role of ['migrator', 'app_rw', 'wf_executor']) {
      expect(sql).toMatch(new RegExp(`alter role ${role} with [^;]*nosuperuser[^;]*nobypassrls`));
    }
  });
});
