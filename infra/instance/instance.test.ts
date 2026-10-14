import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('the website and the app hosts (ADR 141)', () => {
  const caddy = read('caddy/Caddyfile');
  const params = read('deploy/fetch-params.sh');

  it('Caddy serves the app, the website, www and the legacy hostnames', () => {
    expect(caddy).toMatch(/^\{\$APP_DOMAIN\} \{[\s\S]*?reverse_proxy 127\.0\.0\.1:3000/m);
    expect(caddy).toMatch(/^\{\$SITE_DOMAIN\} \{/m);
    expect(caddy).toContain('root * /opt/outlet-ops/current/site');
    expect(caddy).toMatch(
      /^www\.\{\$SITE_DOMAIN\} \{\n[\s\S]*?redir https:\/\/\{\$SITE_DOMAIN\}\{uri\} permanent/m,
    );
    expect(caddy).toMatch(/^import \/etc\/outlet-ops\/caddy-legacy\.caddy$/m);
  });

  it('the website reaches the app on one path only, the demo form', () => {
    const site = caddy.slice(
      caddy.indexOf('{$SITE_DOMAIN} {'),
      caddy.indexOf('www.{$SITE_DOMAIN}'),
    );
    expect(site.match(/reverse_proxy/g)).toHaveLength(1);
    expect(site).toMatch(/handle \/api\/demo-request \{\n\t\treverse_proxy 127\.0\.0\.1:3000/);
    expect(site).toMatch(/Content-Security-Policy "default-src 'self'; script-src 'self';/);
  });

  it('the website has clean URLs, a real 404 page and fonts from itself only', () => {
    const site = caddy.slice(
      caddy.indexOf('{$SITE_DOMAIN} {'),
      caddy.indexOf('www.{$SITE_DOMAIN}'),
    );
    expect(site).toMatch(/try_files \{path\} \{path\}\.html\n/); // no fallback to index.html
    expect(site).toMatch(/handle_errors \{[\s\S]*?rewrite \* \/404\.html[\s\S]*?file_server/);
    expect(site).toMatch(
      /@html path_regexp html \^\/\(\.\*\?\)\(index\)\?\\\.html\$\n\tredir @html \/\{re\.html\.1\} permanent/,
    );
    expect(site).toContain("font-src 'self'");
    expect(site).not.toMatch(/googleapis|gstatic/);
  });

  it('the redirect block reads the legacy and app hostnames from the config', () => {
    expect(params).toContain(
      'legacy_domains=${cfg[legacy_domains]}\napp_domain=${cfg[app_domain]}\n{',
    );
  });

  it('Caddy and the web app get the website hostname; the web its origin for the demo form', () => {
    const caddyEnv = params.slice(params.indexOf('caddy.env'));
    expect(caddyEnv).toContain('SITE_DOMAIN=${cfg[site_domain]}');
    const web = params.slice(params.indexOf('web.env'), params.indexOf('wf.env'));
    expect(web).toContain('SITE_URL=${cfg[site_url]}');
    expect(params).toMatch(/for key in [^;]*site_url site_domain legacy_domains/);
  });

  // Runs the part of fetch-params.sh that writes the legacy redirects, with a given value.
  const legacyFile = (legacy: string): string => {
    const start = params.indexOf('{\n  echo "# written by fetch-params.sh');
    const end = params.indexOf('cat > "$OO_ETC/backup.env"');
    const etc = mkdtempSync(join(tmpdir(), 'oo-etc-'));
    execFileSync('bash', [
      '-c',
      `set -euo pipefail; app_domain=my.heysenior.app; legacy_domains="$1";` +
        `OO_ETC="$2"; PARAM_PREFIX=/outlet-ops/prod;\n${params.slice(start, end)}`,
      '_',
      legacy,
      etc,
    ]);
    return readFileSync(join(etc, 'caddy-legacy.caddy'), 'utf8');
  };

  it('writes one redirect per legacy hostname, and none for "-"', () => {
    const two = legacyFile('old.duckdns.org older.example.com');
    expect(two).toContain(
      'old.duckdns.org {\n\timport request_log\n\tredir https://my.heysenior.app{uri} permanent\n}',
    );
    expect(two.match(/redir https:\/\/my\.heysenior\.app\{uri\} permanent/g)).toHaveLength(2);
    expect(legacyFile('-')).not.toContain('redir');
  });

  it('refuses a legacy value that is not a hostname', () => {
    expect(() => legacyFile('evil.com { respond 200 }')).toThrow();
  });

  it('the release bundles the website files', () => {
    expect(read('../scripts/build-release.sh')).toContain(
      '(cd apps/site/public && cp -a . "$OUT/site/")',
    );
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
