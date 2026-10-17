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

  it('wf-execute gets only wf_executor and the Web Push signing key (ADR 137)', () => {
    expect(loadCredentials('outlet-ops-wf-execute.service')).toEqual([
      'db_wf_executor:/etc/outlet-ops/creds/wf_executor',
      'vapid_private:/etc/outlet-ops/creds/vapid_private',
    ]);
  });

  it('the Web Push signing key reaches wf-execute only; the web gets the public key', () => {
    for (const unit of readdirSync(join(dir, 'systemd')).filter(
      (f) => f !== 'outlet-ops-wf-execute.service',
    )) {
      expect(read(join('systemd', unit)), unit).not.toContain('vapid_private');
    }
    const env = read('deploy/fetch-params.sh');
    const web = env.slice(env.indexOf('cat > "$OO_ETC/web.env"'), env.indexOf('wf.env'));
    expect(web).toContain('VAPID_PUBLIC_KEY=${vapid_public}');
    expect(web).not.toContain('vapid_private');
    expect(read('systemd/outlet-ops-wf-execute.service')).toMatch(
      /^EnvironmentFile=\/etc\/outlet-ops\/wf\.env$/m,
    );
  });

  it('the nightly attendance job gets only wf_executor', () => {
    expect(loadCredentials('outlet-ops-attendance-nightly.service')).toEqual([
      'db_wf_executor:/etc/outlet-ops/creds/wf_executor',
    ]);
  });

  it('the tasks job gets only wf_executor (ADR 020)', () => {
    expect(loadCredentials('outlet-ops-tasks-tick.service')).toEqual([
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

  it('the platform worker gets its config (pool, bucket, region), no secrets (ADR 013)', () => {
    expect(read('systemd/outlet-ops-platform-worker.service')).toMatch(
      /^EnvironmentFile=\/etc\/outlet-ops\/platform-worker\.env$/m,
    );
    const env = read('deploy/fetch-params.sh');
    const block = env.slice(env.indexOf('platform-worker.env'), env.indexOf('caddy.env'));
    expect(block).toContain('COGNITO_USER_POOL_ID=');
    expect(block).toContain('PHOTO_BUCKET=');
    expect(block).toContain('AWS_REGION=');
    for (const secret of ['DATABASE_URL', 'SESSION_SECRET', 'creds', 'password']) {
      expect(block, secret).not.toContain(secret);
    }
  });

  it('services run as their own unprivileged users', () => {
    expect(read('systemd/outlet-ops-platform-worker.service')).toMatch(
      /^User=outletops-platform$/m,
    );
    expect(read('systemd/outlet-ops-web.service')).toMatch(/^User=outletops-web$/m);
    expect(read('systemd/outlet-ops-wf-execute.service')).toMatch(/^User=outletops-wf$/m);
    expect(read('systemd/outlet-ops-attendance-nightly.service')).toMatch(/^User=outletops-wf$/m);
    expect(read('systemd/outlet-ops-tasks-tick.service')).toMatch(/^User=outletops-wf$/m);
  });
});

describe('scheduled jobs', () => {
  it('runs the attendance job nightly in India time, catching up after downtime', () => {
    const timer = read('systemd/outlet-ops-attendance-nightly.timer');
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 02:15:00 Asia\/Kolkata$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
  });

  it('runs the tasks job every 5 minutes (ADR 020)', () => {
    expect(read('systemd/outlet-ops-tasks-tick.timer')).toMatch(
      /^OnCalendar=\*-\*-\* \*:00\/5:30$/m,
    );
  });

  it('deploy enables and starts every timer it ships', () => {
    const deploy = read('deploy/deploy.sh');
    for (const t of readdirSync(join(dir, 'systemd')).filter((f) => f.endsWith('.timer'))) {
      expect(deploy.match(new RegExp(t.replace('.', '\\.'), 'g'))?.length).toBe(2);
    }
  });

  it('the bundles’ require shim cannot clash with a bundled createRequire (fflate has one)', () => {
    const banner = /^banner="(.*)"$/m.exec(read('../scripts/build-release.sh'))![1]!;
    expect(banner).toContain('const require =');
    expect(banner).not.toMatch(/import \{ createRequire \}/);
  });

  it('the release bundles every job a unit runs', () => {
    const build = read('../scripts/build-release.sh');
    expect(read('deploy/platform-worker.sh')).toContain('jobs/platform-worker.mjs');
    expect(build).toContain('--outfile="$OUT/jobs/platform-worker.mjs"');
    expect(read('deploy/deploy.sh')).toMatch(/enable[^;]*outlet-ops-platform-worker\.service/);
    for (const script of ['wf-execute', 'attendance-nightly', 'tasks-tick']) {
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

describe('someone is told when the back office stops (ADR 171)', () => {
  const units = readdirSync(join(dir, 'systemd'));
  const migration = readFileSync(
    join(dir, '../../packages/db/migrations/20270123100000_job_heartbeats.sql'),
    'utf8',
  );
  const listed = [...migration.matchAll(/^\s+\('([a-z-]+)', '/gm)].map((m) => m[1]!);
  const heartbeatOf = (unit: string) =>
    /^ExecStartPost=\+?\/opt\/outlet-ops\/current\/deploy\/heartbeat\.sh ([a-z-]+)$/m.exec(
      read(join('systemd', unit)),
    )?.[1];

  it('every service but the notifier itself emails on failure', () => {
    for (const unit of units.filter((u) => u.endsWith('.service'))) {
      if (unit === 'outlet-ops-notify@.service' || unit === 'outlet-ops-imds-guard.service')
        continue;
      if (unit === 'outlet-ops-caddy.service') continue; // the outside check sees Caddy down
      expect(read(join('systemd', unit)), unit).toMatch(
        /^OnFailure=outlet-ops-notify@%n\.service$/m,
      );
    }
    expect(read('systemd/outlet-ops-notify@.service')).not.toMatch(/OnFailure=/);
  });

  it('every job a timer runs records a good run, under a name the database lists', () => {
    for (const timer of units.filter((u) => u.endsWith('.timer'))) {
      const service = timer.replace('.timer', '.service');
      // os-patch records itself in its script, before it may reboot
      const job = service === 'outlet-ops-os-patch.service' ? 'os-patch' : heartbeatOf(service);
      expect(job, service).toBeDefined();
      expect(listed, service).toContain(job);
    }
  });

  it('every job the database lists is recorded by some unit or the watchdog', () => {
    const recorded = new Set(units.map(heartbeatOf).filter(Boolean));
    const watchdog = read('deploy/watchdog.sh');
    for (const m of watchdog.matchAll(/heartbeat ([a-z-]+) true/g)) recorded.add(m[1]);
    recorded.add('os-patch'); // os-patch.sh records itself before it may reboot
    expect(read('deploy/os-patch.sh')).toContain('heartbeat os-patch true');
    expect([...recorded].sort()).toEqual([...listed].sort());
  });

  it('the jobs run as their own users; only the heartbeat runs as root (+)', () => {
    for (const unit of ['wf-execute', 'tasks-tick', 'attendance-nightly']) {
      const text = read(`systemd/outlet-ops-${unit}.service`);
      expect(text).toMatch(/^User=outletops-wf$/m);
      expect(text).toMatch(
        new RegExp(`^ExecStartPost=\\+/opt/outlet-ops/current/deploy/heartbeat\\.sh ${unit}$`, 'm'),
      );
    }
  });

  it('a heartbeat goes to psql on stdin: psql fills in :variables only there, never in -c', () => {
    const lib = read('deploy/lib.sh');
    const at = lib.indexOf('heartbeat() {');
    const fn = lib.slice(at, lib.indexOf('\n}\n', at));
    expect(fn).toContain(
      `echo "select platform.job_ran(:'job', :'ok'::boolean, nullif(:'note', ''));" |`,
    );
    expect(fn).not.toContain(' -c ');
  });

  it('an alert goes out at most once an hour per unit, through the topic in alert.env', () => {
    const lib = read('deploy/lib.sh');
    expect(lib).toContain('find "$stamp" -mmin -60');
    expect(lib).toContain('aws sns publish --topic-arn "$topic"');
    expect(read('deploy/fetch-params.sh')).toContain('ALERT_TOPIC_ARN=${cfg[alert_topic_arn]}');
    expect(read('deploy/fetch-params.sh')).toMatch(/for key in [^;]*alert_topic_arn/);
  });

  it('the watchdog fails at 85 % disk, or when the app or the worker is down', () => {
    const w = read('deploy/watchdog.sh');
    expect(w).toContain('-ge 85');
    expect(w).toContain('http://127.0.0.1:3000/health/db');
    expect(w).toContain('systemctl is-active -q outlet-ops-platform-worker.service');
    expect(read('systemd/outlet-ops-watchdog.timer')).toMatch(
      /^OnCalendar=\*-\*-\* \*:07\/15:00$/m,
    );
  });
});

describe('backups (ADR 171)', () => {
  const backup = read('deploy/pg-backup.sh');

  it('dump to a file, check it, and only then upload: never piped straight to S3', () => {
    expect(backup).not.toMatch(/pg_dump[^\n]*\|/);
    const check = backup.indexOf('pg_restore -l');
    const upload = backup.indexOf('aws s3api put-object');
    expect(check).toBeGreaterThan(backup.indexOf('pg_dump'));
    expect(upload).toBeGreaterThan(check);
    expect(backup).toContain('--content-md5'); // Object Lock needs a checksum
  });

  it('the first dump of each month is locked 7 years', () => {
    expect(backup).toContain('pg-monthly/$MONTH/');
    expect(backup).toContain('--object-lock-mode GOVERNANCE');
    expect(backup).toContain('+2557 days');
  });

  it('the restore check runs weekly and fails on an empty table or a count under 90 %', () => {
    expect(read('systemd/outlet-ops-restore-drill.timer')).toMatch(
      /^OnCalendar=Sun \*-\*-\* 03:30:00 Asia\/Kolkata$/m,
    );
    const drill = read('deploy/restore-drill.sh');
    expect(drill).toContain('$((restored * 10)) -lt $((live * 9))');
    expect(drill).toMatch(/exit 1/);
  });
});

describe('the server itself (ADR 171)', () => {
  it('caps Docker logs and the journal, and prunes old images on deploy', () => {
    const host = read('deploy/host-setup.sh');
    expect(host).toContain('"max-size":"10m","max-file":"3"');
    expect(host).toContain('SystemMaxUse=500M');
    expect(read('deploy/deploy.sh')).toContain('docker image prune -f');
    expect(read('deploy/deploy.sh')).toContain('"$REL_DIR/deploy/host-setup.sh" "$REL_DIR"');
  });

  it('Postgres logs expected refusals without their statement', () => {
    expect(read('postgres/postgresql.conf')).toMatch(/^log_min_error_statement = fatal$/m);
  });

  it('the metadata endpoint is for root, the web app and the platform worker only', () => {
    const guard = read('deploy/imds-guard.sh');
    expect(guard).toContain('--uid-owner 0 -j RETURN');
    expect(guard).toContain('for u in outletops-web outletops-platform; do');
    expect(guard).toMatch(/-A OO-IMDS -j REJECT/);
    expect(guard).not.toContain('outletops-wf');
    expect(read('systemd/outlet-ops-imds-guard.service')).toMatch(/^WantedBy=multi-user\.target$/m);
    expect(read('deploy/deploy.sh')).toMatch(/enable[^;]*outlet-ops-imds-guard\.service/);
  });

  it('Postgres is pinned to a minor version and rebuilt with --pull', () => {
    expect(read('postgres/Dockerfile')).toMatch(/^FROM postgres:16\.\d+$/m);
    expect(read('deploy/postgres-up.sh')).toContain('docker build --pull');
  });

  it('weekly security updates on Sunday morning, from the latest release', () => {
    expect(read('systemd/outlet-ops-os-patch.timer')).toMatch(
      /^OnCalendar=Sun \*-\*-\* 04:30:00 Asia\/Kolkata$/m,
    );
    expect(read('deploy/os-patch.sh')).toContain('--releasever=latest upgrade --security');
  });
});

describe('deploys (ADR 171)', () => {
  const deploy = read('deploy/deploy.sh');

  it('checks /health/db, not /login, and a rollback restarts the worker and units too', () => {
    expect(deploy).toContain('http://127.0.0.1:3000/health/db');
    expect(deploy).not.toContain('127.0.0.1:3000/login');
    const rollback = deploy.slice(deploy.indexOf('health check failed'));
    expect(rollback).toContain('install -m 0644 "$PREV"/systemd/* /etc/systemd/system/');
    expect(rollback).toContain(
      'systemctl restart outlet-ops-web.service outlet-ops-platform-worker.service',
    );
  });

  it('the platform worker finishes its job before a restart (up to 10 minutes)', () => {
    expect(read('systemd/outlet-ops-platform-worker.service')).toMatch(/^TimeoutStopSec=600$/m);
  });

  it('the Deploy workflow runs on master only, and only when CI passed', () => {
    const wf = read('../../.github/workflows/deploy.yml');
    expect(wf).toContain('if [ "$GITHUB_REF" != refs/heads/master ]');
    expect(wf).toContain('checks: read');
    expect(wf).toContain('group_by(.name) | map(max_by(.id))');
    expect(wf.indexOf('Only master with green CI')).toBeLessThan(
      wf.indexOf('Build release bundle'),
    );
  });

  it('Caddy answers /health on plain HTTP and sends everything else to HTTPS', () => {
    const caddy = read('caddy/Caddyfile');
    const start = caddy.indexOf('http://{$APP_DOMAIN} {');
    const http = caddy.slice(start, caddy.indexOf('\n}\n', start) + 2);
    expect(http).toContain('handle /health {');
    expect(http).toContain('redir https://{host}{uri} 308');
    expect(http).not.toContain('/health/db');
  });
});
