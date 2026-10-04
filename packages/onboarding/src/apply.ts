import { syncProcessDefs, syncProductAccess } from '@outlet-ops/workflow';
import { MODULE_CODES } from '@outlet-ops/domain';
import type { ClientBase } from 'pg';
import {
  FILES,
  readBundle,
  TEST_ONLY_FILES,
  type AssignTo,
  type Bundle,
  type Issue,
} from './files';
import { menuWarnings, validateBundle } from './validate';

// Loads one customer's onboarding files (ADR 009): validate, then write everything in one
// transaction. Every write is an upsert on the natural key (codes, usernames), so loading
// the same files again changes nothing; a dry run does the same work and rolls back, so
// its report shows exactly what applying would do. Runs as the migrator role.

export interface Counts {
  created: number;
  updated: number;
  unchanged: number;
}

export interface AccessRow {
  username: string;
  display_name: string;
  access_group: string;
  node_code: string;
  place_name: string;
  covers: 'this place and everything below' | 'this place only';
  source: string;
}

export interface LoadReport {
  ok: boolean;
  applied: boolean;
  customer?: string;
  tenantId?: string;
  issues: Issue[];
  /**
   * Not blockers: people who could start a request that nobody but they could approve
   * (ADR 010). An account owner's is approved at the top of the chain; anyone else's
   * would fail with NO_APPROVER.
   */
  warnings: Issue[];
  counts: Record<string, Counts>;
  /** Every access grant of the people in these files after the load (file 99 layout). */
  access: AccessRow[];
}

export interface LoadOptions {
  /** Roll back at the end: report what would happen without changing anything. */
  dryRun?: boolean;
  /**
   * The client is already inside a transaction (tests): use a savepoint instead of
   * BEGIN/COMMIT. Otherwise the loader owns the transaction on a dedicated client.
   */
  nested?: boolean;
}

/** Validates the files without touching the database. */
export function validateFiles(files: Record<string, string>): { bundle: Bundle; issues: Issue[] } {
  const { bundle, issues } = readBundle(files);
  return { bundle, issues: issues.length ? issues : validateBundle(bundle) };
}

export async function loadCustomer(
  client: ClientBase,
  files: Record<string, string>,
  opts: LoadOptions = {},
): Promise<LoadReport> {
  const { bundle, issues } = validateFiles(files);
  const report: LoadReport = {
    ok: false,
    applied: false,
    issues,
    warnings: [],
    counts: {},
    access: [],
  };
  if (issues.length) return report;

  const begin = opts.nested ? 'savepoint onboarding' : 'begin';
  const rollback = opts.nested ? 'rollback to savepoint onboarding' : 'rollback';
  const commit = opts.nested ? 'release savepoint onboarding' : 'commit';
  await client.query(begin);
  const at = { file: '', row: undefined as number | undefined };
  try {
    const l = new Loader(client, bundle, report, at);
    await l.run();
    report.ok = report.issues.length === 0;
    if (report.ok && !opts.dryRun) {
      await client.query(commit);
      report.applied = true;
    } else {
      await client.query(rollback);
      if (opts.nested) await client.query('release savepoint onboarding');
    }
  } catch (e) {
    await client.query(rollback);
    if (opts.nested) {
      await client.query('release savepoint onboarding');
      // the caller's transaction goes on: its owner check is immediate again
      await client.query('set constraints core.last_account_owner immediate');
    }
    const err = e as { message?: string; detail?: string };
    report.issues.push({
      file: at.file || '(database)',
      ...(at.row !== undefined && { row: at.row }),
      message: [err.message, err.detail].filter(Boolean).join(': '),
    });
    report.ok = false;
  }
  return report;
}

class Loader {
  private tenant = '';
  private isTest = false;
  /** The load date in the customer's time zone: test-only day offsets count from it. */
  private today = '';
  private nodes = new Map<string, string>();
  private users = new Map<string, string>();
  private workers = new Map<string, string>();
  private suppliers = new Map<string, string>();
  private items = new Map<string, string>();
  private leaveTypes = new Map<string, string>();
  /** `store item day` -> the prep task from file 32, for the batches of file 26 */
  private prepTaskIds = new Map<string, string>();

  constructor(
    private c: ClientBase,
    private b: Bundle,
    private report: LoadReport,
    private at: { file: string; row: number | undefined },
  ) {}

  private step(file: string, row?: number) {
    this.at.file = file;
    this.at.row = row;
  }

  /** Runs an upsert that returns `inserted` (xmax = 0) or nothing when unchanged. */
  private async upsert(entity: string, sql: string, params: unknown[]): Promise<string> {
    const counts = (this.report.counts[entity] ??= { created: 0, updated: 0, unchanged: 0 });
    const { rows } = await this.c.query<{ id: string; inserted: boolean }>(sql, params);
    if (rows[0]) {
      if (rows[0].inserted) counts.created++;
      else counts.updated++;
      return rows[0].id;
    }
    counts.unchanged++;
    return '';
  }

  async run(): Promise<void> {
    await this.customer();
    await this.customGroups();
    await this.ownersInFiles();
    if (this.report.issues.length) return;
    await this.structure();
    await this.people();
    if (this.report.issues.length) return;
    await this.access();
    await this.coverage();
    if (this.report.issues.length) return;
    await this.stockReach();
    await this.stock();
    await this.menu();
    await this.leave();
    await this.payRates();
    await this.rostering();
    await this.events();
    await this.checklists();
    if (this.isTest) {
      await this.shifts();
      await this.pastWeek();
      await this.tasks();
      await this.maintenance();
      await this.purchases();
      await this.attendance();
      await this.transfers();
    }
    this.step('');
    this.report.access = await this.preview();
  }

  /**
   * The customer's own access groups (file 05, ADR 027), written through
   * core.put_custom_group, which checks them as the app does. Groups the file doesn't list
   * are left alone: the Account Owner may have built them in the app.
   */
  private async customGroups() {
    const counts = (this.report.counts['access groups'] ??= {
      created: 0,
      updated: 0,
      unchanged: 0,
    });
    for (const g of this.b.customGroups) {
      this.step(FILES.customGroups.file, g.line);
      const { rows } = await this.c.query<{ name: string; acts_as: string[]; rights: unknown }>(
        `select g.name, g.acts_as,
                coalesce((select jsonb_object_agg(d.code, dp.access)
                            from core.domain_policy dp join core.domain d on d.id = dp.domain_id
                           where dp.group_id = g.id), '{}') as rights
           from core.security_group g
          where g.tenant_id = $1 and g.code = $2 and g.kind = 'custom' and g.archived_at is null`,
        [this.tenant, g.group_code],
      );
      const was = rows[0];
      const same =
        was &&
        was.name === g.name &&
        JSON.stringify([...was.acts_as].sort()) === JSON.stringify([...g.acts_as].sort()) &&
        JSON.stringify(sortKeys(was.rights as Record<string, string>)) ===
          JSON.stringify(sortKeys(g.rights));
      if (same) {
        counts.unchanged++;
        continue;
      }
      await this.c.query('select core.put_custom_group($1, $2, $3, $4, $5)', [
        this.tenant,
        g.group_code,
        g.name,
        JSON.stringify(g.rights),
        g.acts_as,
      ]);
      if (was) counts.updated++;
      else counts.created++;
    }
  }

  private async customer() {
    const cu = this.b.customer[0]!;
    this.step(FILES.customer.file, cu.line);
    this.report.customer = cu.customer_code;
    await this.upsert(
      'customer',
      `insert into core.tenant (name, code, country, currency, default_timezone, is_test)
       values ($1, $2, $3, $4, $5, coalesce($6, false))
       on conflict (code) where code is not null do update
          set name = excluded.name, country = excluded.country, currency = excluded.currency,
              default_timezone = excluded.default_timezone
        where (core.tenant.name, core.tenant.country, core.tenant.currency,
               core.tenant.default_timezone)
              is distinct from (excluded.name, excluded.country, excluded.currency,
                                excluded.default_timezone)
       returning id, xmax = 0 as inserted`,
      [
        cu.company_name,
        cu.customer_code,
        cu.country,
        cu.currency,
        cu.default_timezone,
        cu.is_test ?? null,
      ],
    );
    const t = (
      await this.c.query<{ id: string; is_test: boolean }>(
        `select id, is_test from core.tenant where code = $1`,
        [cu.customer_code],
      )
    ).rows[0]!;
    this.tenant = t.id;
    this.isTest = t.is_test;
    // is_test is set when the customer is created and never changes (ADR 012)
    if (cu.is_test !== undefined && cu.is_test !== t.is_test) {
      this.report.issues.push({
        file: FILES.customer.file,
        row: cu.line,
        column: 'is_test',
        message: `this customer was created with is_test = ${t.is_test ? 'yes' : 'no'}, which cannot change (IS_TEST_IMMUTABLE)`,
      });
    }
    this.report.tenantId = this.tenant;
    // the activity files are for test customers only (ADR 017)
    if (!this.isTest) {
      for (const k of TEST_ONLY_FILES.filter((x) => this.b[x].length > 0)) {
        this.report.issues.push({
          file: FILES[k].file,
          message: 'this file is test data: only a test customer (is_test in file 00) may load it',
        });
      }
    }
    this.today = (
      await this.c.query<{ d: string }>(`select (now() at time zone $1)::date::text as d`, [
        cu.default_timezone,
      ])
    ).rows[0]!.d;
    if (cu.leave_hr_approval !== undefined) {
      await this.c.query(
        `update core.tenant set settings = settings || jsonb_build_object('leave_hr_approval', $2::boolean)
          where id = $1 and (settings ->> 'leave_hr_approval')::boolean is distinct from $2`,
        [this.tenant, cu.leave_hr_approval],
      );
    }
    if (cu.swaps_managers_only !== undefined) {
      await this.c.query(
        `update core.tenant set settings = settings || jsonb_build_object('swaps_managers_only', $2::boolean)
          where id = $1 and (settings ->> 'swaps_managers_only')::boolean is distinct from $2`,
        [this.tenant, cu.swaps_managers_only],
      );
    }
    // modules on or off (ADR 026): only the ones the file sets
    for (const m of MODULE_CODES) {
      const on = cu[m];
      if (on === undefined) continue;
      await this.c.query(
        `update core.tenant
            set settings = jsonb_set(settings, '{modules}',
                                     coalesce(settings -> 'modules', '{}') || jsonb_build_object($2::text, $3::boolean))
          where id = $1 and (settings -> 'modules' -> $2::text) is distinct from to_jsonb($3::boolean)`,
        [this.tenant, m, on],
      );
    }
    // groups, domains and the policy matrix the assignments below refer to
    await syncProductAccess(this.c, this.tenant);
    await syncProcessDefs(this.c);
  }

  /**
   * The customer's existing account owners must all be in 07_users.csv (ADR 013): an owner
   * the files don't know would stay next to the files' own owner (the production mix-up:
   * a console-created test-company.owner next to test.account-owner). Blocking; it names
   * both, so the platform admin can fix the files or remove the extra owner first.
   */
  private async ownersInFiles() {
    const existing = await this.c.query<{ username: string }>(
      `select distinct u.username
         from core.role_assignment ra
         join core.security_group g on g.id = ra.group_id and g.code = 'ACCOUNT_OWNER'
         join core.app_user u on u.id = ra.user_id and u.kind = 'human' and u.status = 'active'
        where ra.tenant_id = $1 and ra.effective_from <= current_date
          and (ra.effective_to is null or ra.effective_to >= current_date)
        order by 1`,
      [this.tenant],
    );
    const inFile = new Set(this.b.users.map((u) => u.username));
    const ownerRoles = new Set(
      this.b.jobRoles
        .filter((r) => r.default_access.some((a) => a.group === 'ACCOUNT_OWNER'))
        .map((r) => r.job_role_code),
    );
    const fileOwners = [
      ...new Set([
        ...this.b.users.filter((u) => ownerRoles.has(u.job_role_code)).map((u) => u.username),
        ...this.b.extraAccess
          .filter((e) => e.access_group === 'ACCOUNT_OWNER')
          .map((e) => e.username),
      ]),
    ].sort();
    for (const { username } of existing.rows) {
      if (inFile.has(username)) continue;
      this.report.issues.push({
        file: FILES.users.file,
        column: 'username',
        message:
          `the customer's account owner ${username} has no row in this file, whose account ` +
          `owner is ${fileOwners.join(', ') || '(nobody)'}: loading it would leave both. Add ` +
          `${username} to the file, or remove them first (Platform: the customer, Account owners)`,
      });
    }
  }

  private async structure() {
    const cu = this.b.customer[0]!;
    const tree = [
      ['org', FILES.orgNodes.file, this.b.orgNodes],
      ['delivery', FILES.deliveryNodes.file, this.b.deliveryNodes],
    ] as const;
    for (const [type, file, rows] of tree) {
      // parents first
      const byCode = new Map<string, (typeof rows)[number]>(rows.map((n) => [n.node_code, n]));
      const depth = (code: string): number => {
        const p = byCode.get(code)?.parent_code;
        return p ? 1 + depth(p) : 0;
      };
      const ordered = [...rows].sort((a, x) => depth(a.node_code) - depth(x.node_code));
      // a main store that moves: clear old flags first so the one-per-parent index holds
      if (type === 'delivery') {
        await this.c.query(
          `update core.hierarchy_node set is_main_store = false
            where tenant_id = $1 and is_main_store and not (code = any ($2))`,
          [
            this.tenant,
            this.b.deliveryNodes.filter((n) => n.is_main_store).map((n) => n.node_code),
          ],
        );
      }
      for (const n of ordered) {
        this.step(file, n.line);
        const d = 'holds_stock' in n ? n : undefined;
        const o = 'outlet_format' in n ? n : undefined;
        await this.upsert(
          `${type} places`,
          `insert into core.hierarchy_node (tenant_id, type, kind, name, code, parent_id, timezone,
                                            outlet_format, holds_stock, is_main_store,
                                            department_type)
           values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, false), coalesce($10, false), $11)
           on conflict (tenant_id, code) where code is not null do update
              set name = excluded.name, kind = excluded.kind, parent_id = excluded.parent_id,
                  timezone = excluded.timezone, outlet_format = excluded.outlet_format,
                  holds_stock = excluded.holds_stock, is_main_store = excluded.is_main_store,
                  department_type = excluded.department_type, archived_at = null
            where (core.hierarchy_node.name, core.hierarchy_node.kind,
                   core.hierarchy_node.parent_id, core.hierarchy_node.timezone,
                   core.hierarchy_node.outlet_format, core.hierarchy_node.holds_stock,
                   core.hierarchy_node.is_main_store, core.hierarchy_node.department_type,
                   core.hierarchy_node.archived_at)
                  is distinct from (excluded.name, excluded.kind, excluded.parent_id,
                                    excluded.timezone, excluded.outlet_format,
                                    excluded.holds_stock, excluded.is_main_store,
                                    excluded.department_type, null)
           returning id, xmax = 0 as inserted`,
          [
            this.tenant,
            type,
            n.kind,
            n.name,
            n.node_code,
            n.parent_code ? this.nodes.get(n.parent_code) : null,
            n.timezone ?? (n.kind === 'outlet' || n.kind === 'site' ? cu.default_timezone : null),
            o?.outlet_format ?? null,
            d ? d.holds_stock : null,
            d ? d.is_main_store : null,
            o?.department_type ?? null,
          ],
        );
        const id = (
          await this.c.query<{ id: string }>(
            `select id from core.hierarchy_node where tenant_id = $1 and code = $2`,
            [this.tenant, n.node_code],
          )
        ).rows[0]!.id;
        this.nodes.set(n.node_code, id);
      }
    }
    for (const l of this.b.nodeLinks) {
      this.step(FILES.nodeLinks.file, l.line);
      await this.upsert(
        'links',
        `insert into core.node_link (tenant_id, org_node_id, delivery_node_id) values ($1, $2, $3)
         on conflict do nothing returning org_node_id as id, true as inserted`,
        [this.tenant, this.nodes.get(l.org_node_code), this.nodes.get(l.delivery_node_code)],
      );
    }
    for (const s of this.b.locations) {
      this.step(FILES.locations.file, s.line);
      const node = this.nodes.get(s.org_node_code);
      await this.locationSetInApp(s, node);
      await this.upsert(
        'location settings',
        `insert into hr.node_setting (tenant_id, org_node_id, latitude, longitude, geofence_radius_m)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, org_node_id) do update
            set latitude = excluded.latitude, longitude = excluded.longitude,
                geofence_radius_m = excluded.geofence_radius_m,
                set_in_app_by = null, set_in_app_at = null
          where (hr.node_setting.latitude, hr.node_setting.longitude,
                 hr.node_setting.geofence_radius_m)
                is distinct from (excluded.latitude, excluded.longitude, excluded.geofence_radius_m)
             or hr.node_setting.set_in_app_by is not null
         returning id, xmax = 0 as inserted`,
        [this.tenant, node, s.latitude, s.longitude, s.geofence_radius_m],
      );
    }
  }

  private async people() {
    // job roles and their default access (authoritative per role)
    const titles = new Map<string, { title: string; dept?: string | undefined }>();
    for (const r of this.b.jobRoles) {
      if (!titles.has(r.job_role_code) || r.outlet_format === 'any') {
        titles.set(r.job_role_code, { title: r.job_title, dept: r.usual_department });
      }
    }
    for (const [code, t] of titles) {
      this.step(FILES.jobRoles.file, this.b.jobRoles.find((r) => r.job_role_code === code)!.line);
      await this.upsert(
        'job roles',
        `insert into hr.job_role (tenant_id, code, name, usual_department) values ($1, $2, $3, $4)
         on conflict (tenant_id, code) do update
            set name = excluded.name, usual_department = excluded.usual_department,
                archived_at = null
          where (hr.job_role.name, hr.job_role.usual_department, hr.job_role.archived_at)
                is distinct from (excluded.name, excluded.usual_department, null)
         returning id, xmax = 0 as inserted`,
        [this.tenant, code, t.title, t.dept ?? null],
      );
    }
    const wanted: string[] = [];
    for (const r of this.b.jobRoles) {
      this.step(FILES.jobRoles.file, r.line);
      for (const [i, a] of r.default_access.entries()) {
        wanted.push([r.job_role_code, r.outlet_format, a.group, a.scope].join(' '));
        await this.upsert(
          'job role access',
          `insert into hr.job_role_access (tenant_id, job_role_code, outlet_format, access_group,
                                           scope, include_descendants, position)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (tenant_id, job_role_code, outlet_format, access_group, scope) do update
              set include_descendants = excluded.include_descendants, position = excluded.position
            where (hr.job_role_access.include_descendants, hr.job_role_access.position)
                  is distinct from (excluded.include_descendants, excluded.position)
           returning id, xmax = 0 as inserted`,
          [
            this.tenant,
            r.job_role_code,
            r.outlet_format,
            a.group,
            a.scope,
            a.includeDescendants,
            i,
          ],
        );
      }
    }
    this.step(FILES.jobRoles.file);
    await this.c.query(
      `delete from hr.job_role_access
        where tenant_id = $1
          and not (job_role_code || ' ' || outlet_format || ' ' || access_group || ' ' || scope
                   = any ($2))`,
      [this.tenant, wanted],
    );

    if (await this.loginClashes()) return;
    // the Test<Role>!12 password rule is for test customers only (ADR 012)
    if (!this.isTest) {
      for (const u of this.b.users.filter((x) => x.password_mode === 'test_rule')) {
        this.report.issues.push({
          file: FILES.users.file,
          row: u.line,
          column: 'password_mode',
          message: 'test_rule passwords are only for test customers (is_test in file 00)',
        });
      }
      if (this.report.issues.length) return;
    }
    for (const u of this.b.users) {
      this.step(FILES.users.file, u.line);
      await this.upsert(
        'users',
        `insert into core.app_user (tenant_id, kind, display_name, username, email, login_type)
         values ($1, 'human', $2, $3, $4, $5)
         on conflict (tenant_id, username) where username is not null do update
            set display_name = excluded.display_name, email = excluded.email,
                login_type = excluded.login_type
          where (core.app_user.display_name, core.app_user.email, core.app_user.login_type)
                is distinct from (excluded.display_name, excluded.email, excluded.login_type)
         returning id, xmax = 0 as inserted`,
        [this.tenant, u.display_name, u.username, u.email ?? null, u.login_type],
      );
      const user = (
        await this.c.query<{ id: string }>(
          `select id from core.app_user where tenant_id = $1 and username = $2`,
          [this.tenant, u.username],
        )
      ).rows[0]!.id;
      this.users.set(u.username, user);
      await this.upsert(
        'workers',
        `insert into hr.worker (tenant_id, owner_user_id, org_node_id, role_code, employment_type,
                                joined_on)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (tenant_id, owner_user_id) do update
            set org_node_id = excluded.org_node_id, role_code = excluded.role_code,
                employment_type = excluded.employment_type, joined_on = excluded.joined_on
          where (hr.worker.org_node_id, hr.worker.role_code, hr.worker.employment_type,
                 hr.worker.joined_on)
                is distinct from (excluded.org_node_id, excluded.role_code,
                                  excluded.employment_type, excluded.joined_on)
         returning id, xmax = 0 as inserted`,
        [
          this.tenant,
          user,
          this.nodes.get(u.home_node_code),
          u.job_role_code,
          u.employment_type,
          u.joined_on ?? null,
        ],
      );
      this.workers.set(
        u.username,
        (
          await this.c.query<{ id: string }>(
            `select id from hr.worker where tenant_id = $1 and owner_user_id = $2`,
            [this.tenant, user],
          )
        ).rows[0]!.id,
      );
    }

    // every job-role scope must resolve for every person
    for (const u of this.b.users) {
      const { rows } = await this.c.query<{ error: string }>(
        `select error from core.derive_job_role_access($1) where error is not null`,
        [this.users.get(u.username)],
      );
      for (const r of rows) {
        this.report.issues.push({
          file: FILES.users.file,
          row: u.line,
          column: 'job_role_code',
          message: `${u.job_role_code} at ${u.home_node_code}: ${r.error}`,
        });
      }
    }
  }

  /**
   * Logins are unique across all customers (one Cognito pool, ADR 011): a username or
   * email another customer already uses is reported with a suggestion prefixed with this
   * customer's code. Returns whether any clashed.
   */
  private async loginClashes(): Promise<boolean> {
    const code = this.b.customer[0]!.customer_code.toLowerCase();
    const { rows } = await this.c.query<{ username: string | null; email: string | null }>(
      `select lower(username) as username, lower(email) as email from core.app_user
        where kind = 'human' and tenant_id is distinct from $1
          and (lower(username) = any ($2) or lower(email) = any ($3))`,
      [
        this.tenant,
        this.b.users.map((u) => u.username.toLowerCase()),
        this.b.users.flatMap((u) => (u.email ? [u.email.toLowerCase()] : [])),
      ],
    );
    const usernames = new Set(rows.map((r) => r.username));
    const emails = new Set(rows.map((r) => r.email));
    for (const u of this.b.users) {
      if (usernames.has(u.username.toLowerCase())) {
        this.report.issues.push({
          file: FILES.users.file,
          row: u.line,
          column: 'username',
          message: `${u.username} is used by another customer (USERNAME_TAKEN); try ${code}.${u.username}`,
        });
      }
      if (u.email && emails.has(u.email.toLowerCase())) {
        this.report.issues.push({
          file: FILES.users.file,
          row: u.line,
          column: 'email',
          message: `${u.email} is used by another customer's login (EMAIL_TAKEN)`,
        });
      }
    }
    return rows.length > 0;
  }

  private async access() {
    // An owner may hold ACCOUNT_OWNER through their job role before and through file 08
    // after (or the other way round): check "at least one Account Owner" once access is
    // re-derived, not half-way (ADR 013). Checked below, so a dry run reports it too.
    await this.c.query('set constraints core.last_account_owner deferred');
    for (const u of this.b.users) {
      this.step(FILES.users.file, u.line);
      await this.c.query('select core.apply_job_role_access($1)', [this.users.get(u.username)]);
    }
    const wanted: string[] = [];
    for (const e of this.b.extraAccess) {
      this.step(FILES.extraAccess.file, e.line);
      const user = this.users.get(e.username)!;
      const node = this.nodes.get(e.node_code)!;
      wanted.push(`${user} ${e.access_group} ${node}`);
      await this.upsert(
        'extra access',
        `with g as (select id from core.security_group where tenant_id = $1 and code = $3),
         upd as (
           update core.role_assignment ra set include_descendants = $5, source_note = $6
             from g
            where ra.user_id = $2 and ra.group_id = g.id and ra.node_id = $4
              and ra.source = 'extra'
              and (ra.include_descendants, ra.source_note) is distinct from ($5, $6)
           returning ra.id, false as inserted),
         ins as (
           insert into core.role_assignment (tenant_id, user_id, group_id, node_id,
                                             include_descendants, source, source_note)
           select $1, $2, g.id, $4, $5, 'extra', $6 from g
            where not exists (select 1 from core.role_assignment ra
                               where ra.user_id = $2 and ra.group_id = g.id and ra.node_id = $4)
           returning id, true as inserted)
         select * from upd union all select * from ins`,
        [this.tenant, user, e.access_group, node, e.include_descendants, e.reason],
      );
    }
    // the customer's AI agent: a service user with view-only access everywhere (AI_AGENT)
    this.step('');
    const agent = await this.c.query<{ id: string }>(
      `insert into core.app_user (tenant_id, kind, display_name, username)
       values ($1, 'service', 'AI Agent', 'ai-agent')
       on conflict (tenant_id, username) where username is not null
       do update set kind = 'service'
       returning id`,
      [this.tenant],
    );
    await this.c.query(
      `insert into core.role_assignment (tenant_id, user_id, group_id, node_id)
       select $1, $2, g.id, n.id
         from core.security_group g, core.hierarchy_node n
        where g.tenant_id = $1 and g.code = 'AI_AGENT'
          and n.tenant_id = $1 and n.parent_id is null
          and not exists (select 1 from core.role_assignment ra
                           where ra.user_id = $2 and ra.group_id = g.id and ra.node_id = n.id)`,
      [this.tenant, agent.rows[0]!.id],
    );

    this.step(FILES.extraAccess.file);
    // extra access no longer in file 08 is removed (the audit log keeps the history)
    await this.c.query(
      `delete from core.role_assignment ra
        where ra.tenant_id = $1 and ra.source = 'extra' and ra.user_id = any ($2)
          and not (ra.user_id || ' ' || (select code from core.security_group where id = ra.group_id)
                   || ' ' || ra.node_id = any ($3))`,
      [this.tenant, [...this.users.values()], wanted],
    );
    this.step(FILES.extraAccess.file);
    await this.c.query('set constraints core.last_account_owner immediate');
  }

  /** Every process must have an approver at every place (ADR 009): list each gap. */
  private async coverage() {
    this.step('');
    const { rows } = await this.c.query<{
      process_type: string;
      step: string;
      node_code: string | null;
    }>('select process_type, step, node_code from wf.approval_coverage($1)', [this.tenant]);
    for (const r of rows) {
      const org = this.b.orgNodes.find((n) => n.node_code === r.node_code);
      const dlv = this.b.deliveryNodes.find((n) => n.node_code === r.node_code);
      this.report.issues.push({
        file: org ? FILES.orgNodes.file : FILES.deliveryNodes.file,
        ...((org ?? dlv) && { row: (org ?? dlv)!.line }),
        column: 'node_code',
        message: `${r.process_type} ${r.step}: nobody can approve at ${r.node_code} (NO_APPROVER)`,
      });
    }
    await this.peopleCoverage();
  }

  /**
   * A location set in the app since the last import (ADR 018): a warning naming who set it
   * and when, before this file replaces it. Same values: nothing to warn about.
   */
  private async locationSetInApp(
    s: {
      line: number;
      org_node_code: string;
      latitude: number;
      longitude: number;
      geofence_radius_m: number;
    },
    node: string | undefined,
  ) {
    const { rows } = await this.c.query<{ who: string; at: string; was: string }>(
      `select u.display_name as who,
              to_char(ns.set_in_app_at at time zone hr.node_tz(ns.org_node_id), 'DD Mon YYYY HH24:MI')
                || ' ' || hr.node_tz(ns.org_node_id) as at,
              trim_scale(ns.latitude) || ', ' || trim_scale(ns.longitude) || ', '
                || ns.geofence_radius_m || ' m' as was
         from hr.node_setting ns join core.app_user u on u.id = ns.set_in_app_by
        where ns.tenant_id = $1 and ns.org_node_id = $2
          and (ns.latitude, ns.longitude, ns.geofence_radius_m)
              is distinct from ($3::numeric, $4::numeric, $5::int)`,
      [this.tenant, node, s.latitude, s.longitude, s.geofence_radius_m],
    );
    const r = rows[0];
    if (!r) return;
    this.report.warnings.push({
      file: FILES.locations.file,
      row: s.line,
      column: 'org_node_code',
      message:
        `${s.org_node_code}: the location was set in the app by ${r.who} on ${r.at} (${r.was}); ` +
        `this import replaces it with ${s.latitude}, ${s.longitude}, ${s.geofence_radius_m} m`,
    });
  }

  /** People whose own requests nobody else could approve: one warning per person and process. */
  private async peopleCoverage() {
    const { rows } = await this.c.query<{
      username: string;
      process_type: string;
      step: string;
      node_code: string;
      account_owner: boolean;
    }>(
      `select username, process_type, step, node_code, account_owner
         from wf.people_without_approver($1)`,
      [this.tenant],
    );
    const byKey = new Map<string, { steps: Set<string>; places: Set<string>; owner: boolean }>();
    for (const r of rows) {
      const key = `${r.username}\t${r.process_type}`;
      const e = byKey.get(key) ?? { steps: new Set(), places: new Set(), owner: r.account_owner };
      e.steps.add(r.step);
      e.places.add(r.node_code);
      byKey.set(key, e);
    }
    for (const [key, e] of byKey) {
      const [username, process] = key.split('\t') as [string, string];
      const user = this.b.users.find((u) => u.username === username);
      this.report.warnings.push({
        file: FILES.users.file,
        ...(user && { row: user.line }),
        column: 'username',
        message:
          `${username}: ${process} (${[...e.steps].join(', ')}) at ${[...e.places].join(', ')} ` +
          `has no approver but them: ${
            e.owner
              ? 'approved at the top of the chain (account owner)'
              : 'their request would fail (NO_APPROVER)'
          }`,
      });
    }
  }

  /**
   * STOCK_USER and STORE_KEEPER post stock. Granted "this place and everything below" on a
   * store with other stock locations under it (a hub's store above the outlets' stores),
   * they could post at all of them: a warning per grant, naming the extra stores.
   */
  private async stockReach() {
    const { rows } = await this.c.query<{
      username: string;
      grp: string;
      node: string;
      extra: string[];
    }>(
      `select u.username, g.code as grp, n.code as node,
              array_agg(d.code order by d.code) as extra
         from core.role_assignment ra
         join core.app_user u on u.id = ra.user_id
         join core.security_group g on g.id = ra.group_id
         join core.hierarchy_node n on n.id = ra.node_id
         join core.hierarchy_node d
           on d.tenant_id = ra.tenant_id and d.type = n.type and d.holds_stock
          and d.id <> n.id and d.path operator(extensions.<@) n.path
        where ra.tenant_id = $1 and ra.include_descendants and u.status = 'active'
          and g.code in ('STOCK_USER', 'STORE_KEEPER') and u.username = any ($2)
          and (ra.effective_to is null or ra.effective_to >= current_date)
        group by u.username, g.code, n.code
        order by u.username, g.code, n.code`,
      [this.tenant, this.b.users.map((u) => u.username)],
    );
    for (const r of rows) {
      const user = this.b.users.find((u) => u.username === r.username);
      this.report.warnings.push({
        file: FILES.users.file,
        ...(user && { row: user.line }),
        column: 'username',
        message:
          `${r.username}: ${r.grp} at ${r.node} also reaches ${r.extra.length} other stock ` +
          `location${r.extra.length === 1 ? '' : 's'} through the places below it: ` +
          `${r.extra.join(', ')}. Add "(this store only)" if they work at ${r.node} only`,
      });
    }
  }

  private async stock() {
    const cu = this.b.customer[0]!;
    for (const s of this.b.suppliers) {
      this.step(FILES.suppliers.file, s.line);
      await this.upsert(
        'suppliers',
        // a blank email or phone keeps what was set in the app (PO-4, ADR 032)
        `insert into inv.supplier (tenant_id, code, name, lead_time_days, contact, phone)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (tenant_id, code) where code is not null do update
            set name = excluded.name, lead_time_days = excluded.lead_time_days,
                contact = coalesce(excluded.contact, inv.supplier.contact),
                phone = coalesce(excluded.phone, inv.supplier.phone), archived_at = null
          where (inv.supplier.name, inv.supplier.lead_time_days, inv.supplier.contact,
                 inv.supplier.phone, inv.supplier.archived_at)
                is distinct from (excluded.name, excluded.lead_time_days,
                                  coalesce(excluded.contact, inv.supplier.contact),
                                  coalesce(excluded.phone, inv.supplier.phone), null)
         returning id, xmax = 0 as inserted`,
        [
          this.tenant,
          s.supplier_code,
          s.name,
          s.lead_time_days,
          s.contact_email ?? null,
          s.contact_phone ?? null,
        ],
      );
      this.suppliers.set(
        s.supplier_code,
        (
          await this.c.query<{ id: string }>(
            `select id from inv.supplier where tenant_id = $1 and code = $2`,
            [this.tenant, s.supplier_code],
          )
        ).rows[0]!.id,
      );
    }
    const supplier = (code?: string) => (code ? this.suppliers.get(code) : null);
    for (const i of this.b.items) {
      this.step(FILES.items.file, i.line);
      await this.upsert(
        'items',
        `insert into inv.item (tenant_id, sku, name, category, base_uom, is_perishable,
                               standard_unit_cost, preferred_supplier_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (tenant_id, sku) do update
            set name = excluded.name, category = excluded.category, base_uom = excluded.base_uom,
                is_perishable = excluded.is_perishable,
                standard_unit_cost = excluded.standard_unit_cost,
                preferred_supplier_id = excluded.preferred_supplier_id, archived_at = null
          where (inv.item.name, inv.item.category, inv.item.base_uom, inv.item.is_perishable,
                 inv.item.standard_unit_cost, inv.item.preferred_supplier_id, inv.item.archived_at)
                is distinct from (excluded.name, excluded.category, excluded.base_uom,
                                  excluded.is_perishable, excluded.standard_unit_cost,
                                  excluded.preferred_supplier_id, null)
         returning id, xmax = 0 as inserted`,
        [
          this.tenant,
          i.item_code,
          i.name,
          i.category,
          i.base_unit,
          i.is_perishable,
          i.standard_unit_cost_inr,
          supplier(i.preferred_supplier_code),
        ],
      );
      this.items.set(
        i.item_code,
        (
          await this.c.query<{ id: string }>(
            `select id from inv.item where tenant_id = $1 and sku = $2`,
            [this.tenant, i.item_code],
          )
        ).rows[0]!.id,
      );
    }
    for (const l of this.b.itemLocations) {
      this.step(FILES.itemLocations.file, l.line);
      await this.upsert(
        'item locations',
        `insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level, reorder_qty,
                                    count_tolerance_pct, preferred_supplier_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id, item_id, delivery_node_id) do update
            set par_level = excluded.par_level, reorder_qty = excluded.reorder_qty,
                count_tolerance_pct = excluded.count_tolerance_pct,
                preferred_supplier_id = excluded.preferred_supplier_id, archived_at = null
          where (inv.item_node.par_level, inv.item_node.reorder_qty,
                 inv.item_node.count_tolerance_pct, inv.item_node.preferred_supplier_id,
                 inv.item_node.archived_at)
                is distinct from (excluded.par_level, excluded.reorder_qty,
                                  excluded.count_tolerance_pct, excluded.preferred_supplier_id,
                                  null)
         returning id, xmax = 0 as inserted`,
        [
          this.tenant,
          this.items.get(l.item_code),
          this.nodes.get(l.store_node_code),
          l.par_level,
          l.reorder_qty,
          l.count_tolerance_pct ?? null,
          supplier(l.preferred_supplier_code),
        ],
      );
    }
    // opening stock: only where the item has never moved at that store
    for (const o of this.b.openingStock) {
      this.step(FILES.openingStock.file, o.line);
      const counts = (this.report.counts['opening stock'] ??= {
        created: 0,
        updated: 0,
        unchanged: 0,
      });
      if (o.quantity === 0) {
        counts.unchanged++;
        continue;
      }
      const { rowCount } = await this.c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                       unit_cost, currency, ref_type, reason, occurred_at)
         select $1, $2, $3, 'receipt', $4, $5, $6, 'opening', 'opening balance',
                ($7::date)::timestamp at time zone $8
          where not exists (select 1 from inv.stock_ledger l
                             where l.item_id = $2 and l.delivery_node_id = $3)`,
        [
          this.tenant,
          this.items.get(o.item_code),
          this.nodes.get(o.store_node_code),
          o.quantity,
          o.unit_cost_inr,
          cu.currency,
          o.as_of_date,
          this.timezoneOf(o.store_node_code),
        ],
      );
      if (rowCount) counts.created++;
      else counts.unchanged++;
    }
  }

  // Files 18-24 (ADR 014). Prep items are stock items made in-house; recipes and prices
  // are versioned: a changed recipe or price closes the open version and starts a new one
  // today (a second change on the same day replaces today's version).
  private async menu() {
    this.report.warnings.push(...menuWarnings(this.b));
    for (const u of this.b.unitConversions) {
      this.step(FILES.unitConversions.file, u.line);
      await this.upsert(
        'unit conversions',
        `insert into inv.item_unit (tenant_id, item_id, recipe_unit, recipe_units_per_stock_unit)
         values ($1, $2, $3, $4)
         on conflict (tenant_id, item_id) do update
            set recipe_unit = excluded.recipe_unit,
                recipe_units_per_stock_unit = excluded.recipe_units_per_stock_unit
          where (inv.item_unit.recipe_unit, inv.item_unit.recipe_units_per_stock_unit)
                is distinct from (excluded.recipe_unit, excluded.recipe_units_per_stock_unit)
         returning id, xmax = 0 as inserted`,
        [this.tenant, this.items.get(u.item_code), u.recipe_unit, u.recipe_units_per_stock_unit],
      );
    }
    const PREP_CATEGORY = {
      kitchen_prep: 'Kitchen prep',
      house_mixer: 'House mixer',
      batched_cocktail: 'Batched cocktail',
    } as const;
    for (const p of this.b.prepItems) {
      this.step(FILES.prepItems.file, p.line);
      await this.upsert(
        'prep items',
        `insert into inv.item (tenant_id, sku, name, category, base_uom, is_perishable, kind,
                               prep_type, shelf_life_hours)
         values ($1, $2, $3, $4, $5, true, 'prep', $6, $7)
         on conflict (tenant_id, sku) do update
            set name = excluded.name, category = excluded.category, base_uom = excluded.base_uom,
                kind = 'prep', prep_type = excluded.prep_type,
                shelf_life_hours = excluded.shelf_life_hours, archived_at = null
          where (inv.item.name, inv.item.category, inv.item.base_uom, inv.item.kind,
                 inv.item.prep_type, inv.item.shelf_life_hours, inv.item.archived_at)
                is distinct from (excluded.name, excluded.category, excluded.base_uom, 'prep',
                                  excluded.prep_type, excluded.shelf_life_hours, null)
         returning id, xmax = 0 as inserted`,
        [
          this.tenant,
          p.prep_item_code,
          p.name,
          PREP_CATEGORY[p.prep_type],
          p.unit,
          p.prep_type,
          p.shelf_life_hours,
        ],
      );
      this.items.set(
        p.prep_item_code,
        (
          await this.c.query<{ id: string }>(
            `select id from inv.item where tenant_id = $1 and sku = $2`,
            [this.tenant, p.prep_item_code],
          )
        ).rows[0]!.id,
      );
    }
    for (const l of this.b.prepLocations) {
      this.step(FILES.prepLocations.file, l.line);
      await this.upsert(
        'prep locations',
        `insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level, made_here)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, item_id, delivery_node_id) do update
            set par_level = excluded.par_level, made_here = excluded.made_here, archived_at = null
          where (inv.item_node.par_level, inv.item_node.made_here, inv.item_node.archived_at)
                is distinct from (excluded.par_level, excluded.made_here, null)
         returning id, xmax = 0 as inserted`,
        [
          this.tenant,
          this.items.get(l.prep_item_code),
          this.nodes.get(l.store_node_code),
          l.par_level,
          l.made_here,
        ],
      );
    }

    const menuItems = new Map<string, string>();
    for (const m of this.b.menuItems) {
      this.step(FILES.menuItems.file, m.line);
      await this.upsert(
        'menu items',
        `insert into menu.menu_item (tenant_id, code, name, menu, category, serving)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (tenant_id, code) do update
            set name = excluded.name, menu = excluded.menu, category = excluded.category,
                serving = excluded.serving, archived_at = null
          where (menu.menu_item.name, menu.menu_item.menu, menu.menu_item.category,
                 menu.menu_item.serving, menu.menu_item.archived_at)
                is distinct from (excluded.name, excluded.menu, excluded.category,
                                  excluded.serving, null)
         returning id, xmax = 0 as inserted`,
        [this.tenant, m.menu_item_code, m.name, m.menu, m.category, m.serving],
      );
      menuItems.set(
        m.menu_item_code,
        (
          await this.c.query<{ id: string }>(
            `select id from menu.menu_item where tenant_id = $1 and code = $2`,
            [this.tenant, m.menu_item_code],
          )
        ).rows[0]!.id,
      );
    }

    const cu = this.b.customer[0]!;
    for (const o of this.b.menuOutlets) {
      this.step(FILES.menuOutlets.file, o.line);
      const counts = (this.report.counts['menu prices'] ??= {
        created: 0,
        updated: 0,
        unchanged: 0,
      });
      const item = menuItems.get(o.menu_item_code)!;
      const outlet = this.nodes.get(o.outlet_code)!;
      const store = this.nodes.get(o.sold_from_store_code)!;
      // in force today, and a change someone planned for a later date (kept as planned)
      const { rows } = await this.c.query<{
        id: string;
        price: string;
        delivery_node_id: string;
        starts_today: boolean;
        planned: boolean;
        effective_from: string;
      }>(
        `select id, price, delivery_node_id, effective_from = current_date as starts_today,
                effective_from > current_date as planned, effective_from::text
           from menu.menu_outlet
          where menu_item_id = $1 and org_node_id = $2
            and (effective_to is null or effective_to >= current_date)
          order by effective_from`,
        [item, outlet],
      );
      const now = rows.find((r) => !r.planned);
      const planned = rows.find((r) => r.planned);
      if (now && Number(now.price) === o.price_inr_before_tax && now.delivery_node_id === store) {
        counts.unchanged++;
        continue;
      }
      if (now?.starts_today) {
        await this.c.query(
          `update menu.menu_outlet set price = $2, delivery_node_id = $3 where id = $1`,
          [now.id, o.price_inr_before_tax, store],
        );
      } else {
        if (now) {
          await this.c.query(
            `update menu.menu_outlet set effective_to = current_date - 1 where id = $1`,
            [now.id],
          );
        }
        await this.c.query(
          `insert into menu.menu_outlet (tenant_id, menu_item_id, org_node_id, delivery_node_id,
                                         price, currency, effective_from, effective_to)
           values ($1, $2, $3, $4, $5, $6, current_date, $7::date - 1)`,
          [
            this.tenant,
            item,
            outlet,
            store,
            o.price_inr_before_tax,
            cu.currency,
            planned?.effective_from ?? null,
          ],
        );
      }
      if (now) counts.updated++;
      else counts.created++;
    }

    // POS item codes per outlet (ADR 039): added or moved to the item named; codes not in
    // the file are kept (a manager may have matched them on the import screen)
    for (const o of this.b.menuOutlets) {
      if (o.pos_code === undefined) continue;
      this.step(FILES.menuOutlets.file, o.line);
      const counts = (this.report.counts['POS codes'] ??= { created: 0, updated: 0, unchanged: 0 });
      const item = menuItems.get(o.menu_item_code)!;
      const outlet = this.nodes.get(o.outlet_code)!;
      const store = this.nodes.get(o.sold_from_store_code)!;
      const { rows } = await this.c.query<{
        id: string;
        menu_item_id: string;
        delivery_node_id: string;
      }>(
        `select id, menu_item_id, delivery_node_id from menu.pos_item
          where tenant_id = $1 and org_node_id = $2 and pos_code = $3`,
        [this.tenant, outlet, o.pos_code],
      );
      const was = rows[0];
      if (was && was.menu_item_id === item && was.delivery_node_id === store) {
        counts.unchanged++;
      } else if (was) {
        await this.c.query(
          `update menu.pos_item set menu_item_id = $2, delivery_node_id = $3 where id = $1`,
          [was.id, item, store],
        );
        counts.updated++;
      } else {
        await this.c.query(
          `insert into menu.pos_item (tenant_id, org_node_id, delivery_node_id, pos_code, menu_item_id)
           values ($1, $2, $3, $4, $5)`,
          [this.tenant, outlet, store, o.pos_code, item],
        );
        counts.created++;
      }
    }

    // recipes, grouped by what they are for; compared with the version in force
    const groups = new Map<string, Bundle['recipes']>();
    for (const r of this.b.recipes) {
      const k = `${r.recipe_for_kind} ${r.recipe_for_code}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const yields = new Map(this.b.prepItems.map((p) => [p.prep_item_code, p.batch_yield]));
    for (const [key, lines] of groups) {
      this.step(FILES.recipes.file, lines[0]!.line);
      const counts = (this.report.counts['recipes'] ??= { created: 0, updated: 0, unchanged: 0 });
      const [kind, code] = key.split(' ') as ['prep' | 'menu', string];
      const prep = kind === 'prep' ? this.items.get(code)! : null;
      const menuItem = kind === 'menu' ? menuItems.get(code)! : null;
      const batchYield = kind === 'prep' ? yields.get(code)! : null;
      const want = lines.map((l) => ({
        ingredient: this.items.get(l.ingredient_code)!,
        qty: l.quantity,
        unit: l.unit,
        trim: l.trim_loss_pct,
      }));
      // the version in force today, and one planned for a later date (kept as planned)
      const versions = (
        await this.c.query<{
          id: string;
          batch_yield: string | null;
          starts_today: boolean;
          planned: boolean;
          effective_from: string;
          version: number;
        }>(
          `select id, batch_yield, effective_from = current_date as starts_today,
                  effective_from > current_date as planned, effective_from::text, version
             from inv.recipe
            where (prep_item_id = $1 or menu_item_id = $2)
              and (effective_to is null or effective_to >= current_date)
            order by effective_from`,
          [prep, menuItem],
        )
      ).rows;
      const open = versions.find((v) => !v.planned);
      const planned = versions.find((v) => v.planned);
      if (open) {
        const have = (
          await this.c.query<{ ingredient: string; qty: string; unit: string; trim: string }>(
            `select ingredient_item_id as ingredient, qty, unit, trim_loss_pct as trim
               from inv.recipe_line where recipe_id = $1 order by line_no`,
            [open.id],
          )
        ).rows.map((r) => ({
          ingredient: r.ingredient,
          qty: Number(r.qty),
          unit: r.unit,
          trim: Number(r.trim),
        }));
        const sameYield =
          (open.batch_yield === null ? null : Number(open.batch_yield)) === batchYield;
        if (sameYield && JSON.stringify(have) === JSON.stringify(want)) {
          counts.unchanged++;
          continue;
        }
      }
      let recipeId: string;
      if (open?.starts_today) {
        await this.c.query(`delete from inv.recipe_line where recipe_id = $1`, [open.id]);
        await this.c.query(`update inv.recipe set batch_yield = $2 where id = $1`, [
          open.id,
          batchYield,
        ]);
        recipeId = open.id;
      } else {
        if (open) {
          await this.c.query(
            `update inv.recipe set effective_to = current_date - 1 where id = $1`,
            [open.id],
          );
        }
        recipeId = (
          await this.c.query<{ id: string }>(
            `insert into inv.recipe (tenant_id, prep_item_id, menu_item_id, version, effective_from,
                                     effective_to, batch_yield)
             values ($1, $2, $3,
                     (select coalesce(max(version), 0) + 1 from inv.recipe
                       where prep_item_id = $2 or menu_item_id = $3),
                     current_date, $4::date - 1, $5)
             returning id`,
            [this.tenant, prep, menuItem, planned?.effective_from ?? null, batchYield],
          )
        ).rows[0]!.id;
      }
      for (const [i, l] of lines.entries()) {
        this.step(FILES.recipes.file, l.line);
        await this.c.query(
          `insert into inv.recipe_line (tenant_id, recipe_id, line_no, ingredient_item_id, qty,
                                        unit, trim_loss_pct)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [this.tenant, recipeId, i + 1, want[i]!.ingredient, l.quantity, l.unit, l.trim_loss_pct],
        );
      }
      if (open) counts.updated++;
      else counts.created++;
    }

    for (const p of this.b.prepProcedures) {
      this.step(FILES.prepProcedures.file, p.line);
      await this.upsert(
        'prep procedures',
        `insert into inv.prep_procedure (tenant_id, prep_item_id, step, instruction, minutes)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, prep_item_id, step) do update
            set instruction = excluded.instruction, minutes = excluded.minutes
          where (inv.prep_procedure.instruction, inv.prep_procedure.minutes)
                is distinct from (excluded.instruction, excluded.minutes)
         returning id, xmax = 0 as inserted`,
        [this.tenant, this.items.get(p.prep_item_code), p.step, p.instruction, p.minutes ?? null],
      );
    }
  }

  private async leave() {
    for (const t of this.b.leaveTypes) {
      this.step(FILES.leaveTypes.file, t.line);
      await this.upsert(
        'leave types',
        `insert into hr.leave_type (tenant_id, code, name, annual_days) values ($1, $2, $3, $4)
         on conflict (tenant_id, code) do update
            set name = excluded.name, annual_days = excluded.annual_days, archived_at = null
          where (hr.leave_type.name, hr.leave_type.annual_days, hr.leave_type.archived_at)
                is distinct from (excluded.name, excluded.annual_days, null)
         returning id, xmax = 0 as inserted`,
        [this.tenant, t.leave_type_code, t.name, t.annual_days ?? null],
      );
      this.leaveTypes.set(
        t.leave_type_code,
        (
          await this.c.query<{ id: string }>(
            `select id from hr.leave_type where tenant_id = $1 and code = $2`,
            [this.tenant, t.leave_type_code],
          )
        ).rows[0]!.id,
      );
    }
    for (const lb of this.b.leaveBalances) {
      this.step(FILES.leaveBalances.file, lb.line);
      const u = this.b.users.find((x) => x.username === lb.username)!;
      await this.upsert(
        'leave balances',
        `insert into hr.leave_balance (tenant_id, worker_id, owner_user_id, org_node_id,
                                       leave_type_id, year, entitled_days, used_days)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (worker_id, leave_type_id, year) do update
            set entitled_days = excluded.entitled_days, used_days = excluded.used_days,
                org_node_id = excluded.org_node_id
          where (hr.leave_balance.entitled_days, hr.leave_balance.used_days,
                 hr.leave_balance.org_node_id)
                is distinct from (excluded.entitled_days, excluded.used_days, excluded.org_node_id)
         returning id, xmax = 0 as inserted`,
        [
          this.tenant,
          this.workers.get(lb.username),
          this.users.get(lb.username),
          this.nodes.get(u.home_node_code),
          this.leaveTypes.get(lb.leave_type_code),
          lb.year,
          lb.entitled_days,
          lb.used_days,
        ],
      );
    }
  }

  private async rostering() {
    if (this.b.rosterSettings.length) {
      this.step(FILES.rosterSettings.file);
      const v = (s: string) => this.b.rosterSettings.find((r) => r.setting === s)?.value ?? null;
      await this.upsert(
        'roster settings',
        `insert into hr.roster_setting (tenant_id, min_rest_hours, weekly_hours_cap,
                                        late_threshold_min, extra_time_min_minutes)
         values ($1, coalesce($2, 10), coalesce($3, 48), coalesce($4, 10), coalesce($5, 30))
         on conflict (tenant_id) do update
            set min_rest_hours = excluded.min_rest_hours,
                weekly_hours_cap = excluded.weekly_hours_cap,
                late_threshold_min = excluded.late_threshold_min,
                extra_time_min_minutes = excluded.extra_time_min_minutes
          where (hr.roster_setting.min_rest_hours, hr.roster_setting.weekly_hours_cap,
                 hr.roster_setting.late_threshold_min, hr.roster_setting.extra_time_min_minutes)
                is distinct from (excluded.min_rest_hours, excluded.weekly_hours_cap,
                                  excluded.late_threshold_min, excluded.extra_time_min_minutes)
         returning id, xmax = 0 as inserted`,
        [
          this.tenant,
          v('min_rest_hours'),
          v('weekly_hours_cap'),
          v('late_threshold_min'),
          v('extra_time_min_minutes'),
        ],
      );
    }
    for (const t of this.b.shiftTemplates) {
      this.step(FILES.shiftTemplates.file, t.line);
      await this.upsert(
        'shift templates',
        `insert into hr.shift_template (tenant_id, org_node_id, name, role_code, start_time,
                                        end_time, headcount, weekdays)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (tenant_id, org_node_id, name, role_code) do update
            set start_time = excluded.start_time, end_time = excluded.end_time,
                headcount = excluded.headcount, weekdays = excluded.weekdays, archived_at = null
          where (hr.shift_template.start_time, hr.shift_template.end_time,
                 hr.shift_template.headcount, hr.shift_template.weekdays,
                 hr.shift_template.archived_at)
                is distinct from (excluded.start_time, excluded.end_time, excluded.headcount,
                                  excluded.weekdays, null)
         returning id, xmax = 0 as inserted`,
        [
          this.tenant,
          this.nodes.get(t.roster_node_code),
          t.shift_name,
          t.job_role_code,
          t.start_time,
          t.end_time,
          t.headcount,
          t.days,
        ],
      );
    }
  }

  /** Sample events: created once, never changed by a later load. */
  private async events() {
    for (const e of this.b.events) {
      this.step(FILES.events.file, e.line);
      const tz = this.timezoneOf(e.org_node_code);
      const node = this.nodes.get(e.org_node_code);
      const id = await this.upsert(
        'events',
        `insert into ops.event (tenant_id, org_node_id, name, starts_at, ends_at, covers, status)
         select $1, $2, $3, $4::timestamp at time zone $6, $5::timestamp at time zone $6, $7,
                'confirmed'
          where not exists (select 1 from ops.event
                             where tenant_id = $1 and org_node_id = $2 and name = $3
                               and starts_at = $4::timestamp at time zone $6)
         returning id, true as inserted`,
        [this.tenant, node, e.event_name, e.starts_at, e.ends_at, tz, e.covers],
      );
      if (!id) continue;
      const day = e.starts_at.slice(0, 10);
      for (const r of e.requirements) {
        if (r.kind === 'item') {
          await this.c.query(
            `insert into ops.event_requirement (tenant_id, event_id, org_node_id, kind, item_id, qty)
             values ($1, $2, $3, 'item', $4, $5)`,
            [this.tenant, id, node, this.items.get(r.item), r.qty],
          );
        } else {
          await this.c.query(
            `insert into ops.event_requirement (tenant_id, event_id, org_node_id, kind, role_code,
                                                headcount, starts_at, ends_at)
             select $1, $2, $3, 'role', $4, $5, s, case when e <= s then e + interval '1 day' else e end
               from (select ($6 || ' ' || $7)::timestamp at time zone $9 as s,
                            ($6 || ' ' || $8)::timestamp at time zone $9 as e) t`,
            [this.tenant, id, node, r.role, r.headcount, day, r.start, r.end, tz],
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Test-only activity (files 25 to 28, ADR 017). Each row runs through the app's own
  // database functions as the person it names, so every rule holds: rostering rules,
  // production rights, approvals. Day offsets count from the load date.
  //  * Shifts (25) are the two weeks from next Monday: a later load adds the weeks that
  //    are new by then and changes nothing else.
  //  * The past week (26 to 28: batches, sales, the closing count) is loaded once per
  //    customer. A second week would use up the opening stock its batches are made from
  //    (production never goes below zero), so a later re-import would fail.
  // ---------------------------------------------------------------------------------------

  /** Runs `fn` as a person from file 07 (app.user_id), then clears it. */
  private async as<T>(username: string, fn: () => Promise<T>): Promise<T> {
    await this.c.query(`select set_config('app.user_id', $1, true)`, [this.users.get(username)]);
    // on an error the transaction is aborted and rolled back: nothing to clear
    const r = await fn();
    await this.c.query(`select set_config('app.user_id', '', true)`);
    return r;
  }

  private count(entity: string, created: boolean) {
    const n = (this.report.counts[entity] ??= { created: 0, updated: 0, unchanged: 0 });
    if (created) n.created++;
    else n.unchanged++;
  }

  /** `today` plus `days`, as yyyy-mm-dd. */
  private day(days: number, base: string = this.today): string {
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Prices and recipes take effect on the day they are loaded, so a test customer's past
   * week of sales and batches would find none in force. For test customers the first
   * version of each starts at the earliest day in files 26 and 27 instead; later
   * versions keep their dates.
   */
  private async backdateMenu() {
    const days = [...this.b.production.map((p) => p.day), ...this.b.sales.map((x) => x.day)];
    if (days.length === 0) return;
    const since = this.day(Math.min(...days));
    this.step(FILES.menuOutlets.file);
    const prices = await this.c.query(
      `update menu.menu_outlet m set effective_from = $2
        where m.tenant_id = $1 and m.effective_from > $2 and m.effective_from <= current_date
          and not exists (select 1 from menu.menu_outlet o
                           where o.menu_item_id = m.menu_item_id and o.org_node_id = m.org_node_id
                             and o.effective_from < m.effective_from)`,
      [this.tenant, since],
    );
    this.step(FILES.recipes.file);
    const recipes = await this.c.query(
      `update inv.recipe r set effective_from = $2
        where r.tenant_id = $1 and r.effective_from > $2 and r.effective_from <= current_date
          and not exists (select 1 from inv.recipe o
                           where (o.prep_item_id = r.prep_item_id or o.menu_item_id = r.menu_item_id)
                             and o.effective_from < r.effective_from)`,
      [this.tenant, since],
    );
    const n = (this.report.counts['menu dates backdated'] ??= {
      created: 0,
      updated: 0,
      unchanged: 0,
    });
    n.updated += (prices.rowCount ?? 0) + (recipes.rowCount ?? 0);
  }

  /** Files 26 to 28, once per customer: later loads report them unchanged. */
  private async pastWeek() {
    const { rowCount } = await this.c.query(
      `select 1 from inv.production where tenant_id = $1 and idempotency_key like 'test-data %'
       union all
       select 1 from menu.sales_post where tenant_id = $1 and idempotency_key like 'test-data %'
       limit 1`,
      [this.tenant],
    );
    if (rowCount) {
      const same = (entity: string, n: number) => {
        for (let i = 0; i < n; i++) this.count(entity, false);
      };
      same('sales days', new Set(this.b.sales.map((x) => `${x.outlet_code} ${x.day}`)).size);
      same('stock counts', new Set(this.b.counts.map((x) => x.store_node_code)).size);
      // Files 26 and 32 follow the day each store's batches were loaded; rows for a store
      // new to them (the central kitchen, ADR 030) count from today, and stay on that day
      // at later loads.
      const bases = await this.storeBases();
      const made = new Set(this.b.production.map((p) => p.store_node_code));
      // a store in file 32 with no batches in file 26 follows the others
      const loaded = bases.values().next().value ?? this.today;
      const baseOf = (store: string) => bases.get(store) ?? (made.has(store) ? this.today : loaded);
      await this.prepTasks(baseOf);
      await this.production(baseOf);
      await this.linkPastBatches(baseOf);
      return;
    }
    await this.backdateMenu();
    await this.prepTasks();
    await this.production();
    await this.sales();
    await this.counts();
  }

  /** File 25: shifts from the templates, assigned (hr.assign) and published. */
  private async shifts() {
    const today = new Date(`${this.today}T00:00:00Z`);
    const nextMonday = 7 - ((today.getUTCDay() + 6) % 7); // days to next Monday
    const weeks = new Map<string, { node: string; week: string; by: string; line: number }>();
    for (const s of this.b.shifts) {
      this.step(FILES.shifts.file, s.line);
      const node = this.nodes.get(s.roster_node_code)!;
      const weekStart = this.day(nextMonday + 7 * (s.week - 1));
      const worker = this.workers.get(s.username);
      await this.as(s.rostered_by, async () => {
        const made = await this.c.query<{ n: number }>(
          `select hr.generate_week($1, $2::date) as n`,
          [node, weekStart],
        );
        const n = (this.report.counts['shifts'] ??= { created: 0, updated: 0, unchanged: 0 });
        n.created += made.rows[0]!.n;
        for (const d of s.days) {
          const shift = (
            await this.c.query<{ id: string; assigned: boolean }>(
              `select s.id, exists (select 1 from hr.shift_assignment a
                                     where a.shift_id = s.id and a.worker_id = $5
                                       and a.status = 'assigned') as assigned
                 from hr.shift s join hr.shift_template t on t.id = s.template_id
                where t.org_node_id = $1 and t.name = $2 and t.role_code = $3
                  and s.local_date = $4::date + $6::int - 1 and s.status <> 'cancelled'`,
              [node, s.shift_name, s.job_role_code, weekStart, worker, d],
            )
          ).rows[0]!;
          if (!shift.assigned) {
            await this.c.query(`select hr.assign($1, $2)`, [shift.id, worker]);
          }
          this.count('shift assignments', !shift.assigned);
        }
      });
      weeks.set(`${node} ${weekStart}`, { node, week: weekStart, by: s.rostered_by, line: s.line });
    }
    for (const w of weeks.values()) {
      this.step(FILES.shifts.file, w.line);
      await this.as(w.by, () =>
        this.c.query(`select hr.publish_week($1, $2::date)`, [w.node, w.week]),
      );
    }
  }

  /** File 26: batches made at a past time (inv.record_test_production, test customers only). */
  private async production(baseOf: (store: string) => string = () => this.today) {
    for (const p of this.b.production) {
      this.step(FILES.production.file, p.line);
      const date = this.day(p.day, baseOf(p.store_node_code));
      const key = `test-data ${date} ${p.time} ${p.store_node_code} ${p.prep_item_code}`;
      const store = this.nodes.get(p.store_node_code)!;
      const done = await this.c.query(
        `select 1 from inv.production where tenant_id = $1 and idempotency_key = $2`,
        [this.tenant, key],
      );
      if (!done.rowCount) {
        const made = await this.as(p.made_by, () =>
          this.c.query<{ id: string }>(
            `select inv.record_test_production($1, $2, $3,
                      ($4::date + $5::time) at time zone $6, $7) as id`,
            [
              store,
              this.items.get(p.prep_item_code),
              p.quantity,
              date,
              p.time,
              this.timezoneOf(p.store_node_code),
              key,
            ],
          ),
        );
        // the prep task (file 32) this batch fulfils
        const task = this.prepTaskIds.get(`${p.store_node_code} ${p.prep_item_code} ${p.day}`);
        if (task) {
          await this.c.query(`select ops.link_test_batch($1, $2)`, [task, made.rows[0]!.id]);
        }
      }
      this.count('production batches', !done.rowCount);
    }
  }

  /** File 27: a day's sales per outlet, posted as the person named (menu.post_sales). */
  private async sales() {
    const days = new Map<string, Bundle['sales']>();
    for (const x of this.b.sales) {
      const k = `${x.outlet_code} ${x.day} ${x.posted_by}`;
      days.set(k, [...(days.get(k) ?? []), x]);
    }
    const menuItems = new Map(
      (
        await this.c.query<{ code: string; id: string }>(
          `select code, id from menu.menu_item where tenant_id = $1`,
          [this.tenant],
        )
      ).rows.map((r) => [r.code, r.id]),
    );
    for (const lines of days.values()) {
      const first = lines[0]!;
      this.step(FILES.sales.file, first.line);
      const date = this.day(first.day);
      const key = `test-data ${date}`;
      const outlet = this.nodes.get(first.outlet_code)!;
      const done = await this.c.query(
        `select 1 from menu.sales_post p join menu.sales_day d on d.id = p.sales_day_id
          where p.tenant_id = $1 and p.idempotency_key = $2 and d.org_node_id = $3`,
        [this.tenant, key, outlet],
      );
      if (!done.rowCount) {
        await this.as(first.posted_by, () =>
          this.c.query(`select menu.post_sales($1, $2::date, $3, 'manual', $4)`, [
            outlet,
            date,
            JSON.stringify(
              lines.map((l) => ({
                menu_item_id: menuItems.get(l.menu_item_code),
                qty: l.quantity,
              })),
            ),
            key,
          ]),
        );
      }
      this.count('sales days', !done.rowCount);
    }
  }

  /**
   * File 28: a closing count on the load day per store. The counter submits it
   * (inv.submit_count); a variance beyond tolerance goes to STOCK_ADJUSTMENT approval and
   * the approver approves it (wf.act). The executor posts it after the load commits.
   */
  private async counts() {
    const stores = new Map<string, Bundle['counts']>();
    for (const c of this.b.counts) {
      stores.set(c.store_node_code, [...(stores.get(c.store_node_code) ?? []), c]);
    }
    for (const [code, lines] of stores) {
      const first = lines[0]!;
      this.step(FILES.counts.file, first.line);
      const store = this.nodes.get(code)!;
      const done = await this.c.query(
        `select 1 from inv.stock_count
          where delivery_node_id = $1 and status = 'submitted'
            and (submitted_at at time zone $2)::date = $3::date`,
        [store, this.timezoneOf(code), this.today],
      );
      this.count('stock counts', !done.rowCount);
      if (done.rowCount) continue;
      const adjustment = await this.as(first.counted_by, async () => {
        const id = (await this.c.query<{ id: string }>(`select inv.start_count($1) as id`, [store]))
          .rows[0]!.id;
        const system = new Map(
          (
            await this.c.query<{ item_id: string; system_qty: string }>(
              `select item_id, system_qty from inv.stock_count_line where count_id = $1`,
              [id],
            )
          ).rows.map((r) => [r.item_id, Number(r.system_qty)]),
        );
        const counted = lines.map((l) => {
          const item = this.items.get(l.item_code)!;
          return {
            item_id: item,
            counted_qty: Math.max(0, Number(((system.get(item) ?? 0) + l.difference).toFixed(6))),
          };
        });
        return (
          await this.c.query<{ r: { adjustment_id: string | null } }>(
            `select inv.submit_count($1, $2) as r`,
            [id, JSON.stringify(counted)],
          )
        ).rows[0]!.r.adjustment_id;
      });
      if (!adjustment) continue;
      const request = (
        await this.c.query<{ id: string }>(
          `select wf_request_id as id from inv.stock_adjustment where id = $1`,
          [adjustment],
        )
      ).rows[0]!.id;
      await this.as(first.approved_by, () =>
        this.c.query(`select wf.act($1, 'approve', 'Closing count (test data)')`, [request]),
      );
    }
  }

  /**
   * File 33 (ADR 028), once per customer: each order is created by the person who orders
   * (inv.create_po, which submits PURCHASE_ORDER) and approved by the approver (wf.act).
   * It is released on its order day (inv.record_test_release: what the executor's handler
   * does, at that time; the executor later finds it released) and received on its receipt
   * day by the receiver (inv.record_test_receipt, the app's receipt code at that time).
   * Orders at 10:00 and receipts at 11:00, store time.
   */
  private async purchases() {
    if (this.b.purchases.length === 0) return;
    const orders = new Map<string, Bundle['purchases']>();
    for (const p of this.b.purchases) {
      orders.set(p.order_ref, [...(orders.get(p.order_ref) ?? []), p]);
    }
    const loaded = await this.c.query(
      `select 1 from inv.purchase_order
        where tenant_id = $1 and idempotency_key like 'test-data po %' limit 1`,
      [this.tenant],
    );
    for (const [ref, lines] of orders) {
      const first = lines[0]!;
      this.step(FILES.purchases.file, first.line);
      this.count('purchase orders', !loaded.rowCount);
      if (loaded.rowCount) continue;
      const store = this.nodes.get(first.store_node_code)!;
      const tz = this.timezoneOf(first.store_node_code);
      const po = await this.as(
        first.ordered_by,
        async () =>
          (
            await this.c.query<{ id: string }>(`select inv.create_po($1, $2, $3, $4, $5) as id`, [
              store,
              this.suppliers.get(first.supplier_code),
              JSON.stringify(
                lines.map((l) => ({
                  item_id: this.items.get(l.item_code),
                  qty: l.quantity,
                  unit_cost: l.unit_cost_inr,
                })),
              ),
              `Test data ${ref}`,
              `test-data po ${ref}`,
            ])
          ).rows[0]!.id,
      );
      const request = (
        await this.c.query<{ id: string }>(
          `select wf_request_id as id from inv.purchase_order where id = $1`,
          [po],
        )
      ).rows[0]!.id;
      await this.as(first.approved_by, async () => {
        await this.c.query(`select wf.act($1, 'approve', 'Test data order')`, [request]);
        await this.c.query(
          `select inv.record_test_release($1, ($2::date + time '10:00') at time zone $3)`,
          [po, this.day(first.ordered_day), tz],
        );
      });
      const receivedDay = first.received_day;
      if (receivedDay === undefined || first.received_by === undefined) continue;
      await this.as(first.received_by, () =>
        this.c.query(
          `select inv.record_test_receipt($1, $2,
                    ($3::date + time '11:00') at time zone $4, $5)`,
          [
            po,
            JSON.stringify(
              lines.map((l) => ({
                item_id: this.items.get(l.item_code),
                qty: l.received_quantity ?? 0,
                unit_cost: l.unit_cost_inr,
              })),
            ),
            this.day(receivedDay),
            tz,
            `test-data receipt ${ref}`,
          ],
        ),
      );
    }
  }

  /**
   * File 34: a pay rate per person (COMPENSATION, ADR 030), for labour cost. Only rows the
   * file lists change; a rate set in the app for someone not in the file stays.
   */
  private async payRates() {
    for (const r of this.b.payRates) {
      this.step(FILES.payRates.file, r.line);
      const worker = this.workers.get(r.username);
      if (!worker) continue;
      await this.upsert(
        'pay rates',
        `insert into hr.worker_sensitive (tenant_id, worker_id, owner_user_id, org_node_id,
                                          pay_rate, pay_basis)
         select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, $2, $3
           from hr.worker w where w.id = $1
         on conflict (worker_id) do update
            set pay_rate = excluded.pay_rate, pay_basis = excluded.pay_basis
          where (hr.worker_sensitive.pay_rate, hr.worker_sensitive.pay_basis)
                is distinct from (excluded.pay_rate, excluded.pay_basis)
         returning id, (xmax = 0) as inserted`,
        [worker, r.pay_rate_inr, r.pay_basis],
      );
    }
  }

  /**
   * File 35 (test customers only): past sessions, recorded as the person with
   * hr.record_test_attendance, once per customer like the purchases.
   */
  private async attendance() {
    if (this.b.attendance.length === 0) return;
    const loaded = await this.c.query(
      `select 1 from hr.attendance where tenant_id = $1 and in_key like 'test-data att %' limit 1`,
      [this.tenant],
    );
    const home = new Map(this.b.users.map((u) => [u.username, u.home_node_code]));
    for (const a of this.b.attendance) {
      this.step(FILES.attendance.file, a.line);
      if (loaded.rowCount) {
        this.count('attendance sessions', false);
        continue;
      }
      const date = this.day(a.day);
      const tz = this.timezoneOf(home.get(a.username)!);
      // someone signed in as this test person and clocked in on the real system during this
      // session (or is still clocked in): keep their session, skip the test one, and say so
      const clash = await this.c.query<{ at: string }>(
        `select to_char(a.clock_in_at at time zone $5, 'DD Mon HH24:MI') as at
           from hr.attendance a
          where a.worker_id = $1
            and tstzrange(a.clock_in_at, coalesce(a.clock_out_at, 'infinity'))
                && tstzrange(($2::date + $3::time) at time zone $5,
                             ($2::date + $4::time) at time zone $5)
          order by a.clock_in_at limit 1`,
        [this.workers.get(a.username), date, a.clock_in, a.clock_out, tz],
      );
      if (clash.rows[0]) {
        this.report.warnings.push({
          file: FILES.attendance.file,
          row: a.line,
          column: 'username',
          message:
            `${a.username}: skipped ${date} ${a.clock_in}–${a.clock_out}, which overlaps a ` +
            `session clocked in the app at ${clash.rows[0].at}`,
        });
        continue;
      }
      this.count('attendance sessions', true);
      await this.as(a.username, () =>
        this.c.query(
          `select hr.record_test_attendance(($1::date + $2::time) at time zone $4,
                                            ($1::date + $3::time) at time zone $4, $5)`,
          [date, a.clock_in, a.clock_out, tz, `test-data att ${date} ${a.clock_in}`],
        ),
      );
    }
  }

  /**
   * File 36 (test customers only): transfers from the central kitchen, requested, then
   * dispatched and received through the app's own steps at their past times, as the people
   * named (once per customer).
   */
  private async transfers() {
    if (this.b.transfers.length === 0) return;
    const groups = new Map<string, Bundle['transfers']>();
    for (const t of this.b.transfers) {
      groups.set(t.transfer_ref, [...(groups.get(t.transfer_ref) ?? []), t]);
    }
    const loaded = await this.c.query(
      `select 1 from inv.transfer
        where tenant_id = $1 and idempotency_key like 'test-data transfer %' limit 1`,
      [this.tenant],
    );
    for (const [ref, lines] of groups) {
      const first = lines[0]!;
      this.step(FILES.transfers.file, first.line);
      this.count('transfers', !loaded.rowCount);
      if (loaded.rowCount) continue;
      const tz = this.timezoneOf(first.to_store_code);
      const id = await this.as(
        first.requested_by,
        async () =>
          (
            await this.c.query<{ id: string }>(
              `select inv.request_transfer($1, $2, $3, $4) as id`,
              [
                this.nodes.get(first.from_store_code),
                this.nodes.get(first.to_store_code),
                JSON.stringify(
                  lines.map((l) => ({
                    item_id: this.items.get(l.item_code),
                    qty: l.requested_qty,
                  })),
                ),
                `test-data transfer ${ref}`,
              ],
            )
          ).rows[0]!.id,
      );
      const sentDay = first.dispatched_day;
      if (sentDay === undefined || first.dispatched_by === undefined) continue;
      await this.as(first.dispatched_by, () =>
        this.c.query(
          `select inv.record_test_dispatch($1, $2, ($3::date + time '14:00') at time zone $4)`,
          [
            id,
            JSON.stringify(
              lines.map((l) => ({
                item_id: this.items.get(l.item_code),
                qty: l.dispatched_qty ?? l.requested_qty,
              })),
            ),
            this.day(sentDay),
            tz,
          ],
        ),
      );
      const gotDay = first.received_day;
      if (gotDay === undefined || first.received_by === undefined) continue;
      await this.as(first.received_by, () =>
        this.c.query(
          `select inv.record_test_transfer_receipt($1, $2,
                    ($3::date + time '16:00') at time zone $4)`,
          [
            id,
            JSON.stringify(
              lines.map((l) => ({
                item_id: this.items.get(l.item_code),
                qty: l.received_qty ?? l.dispatched_qty ?? l.requested_qty,
              })),
            ),
            this.day(gotDay),
            tz,
          ],
        ),
      );
    }
  }

  /** A task's assignee as the database takes it (ops.check_assign). */
  private assignJson(a: AssignTo): object {
    return a.mode === 'person' ? { mode: 'person', user_id: this.users.get(a.username) } : a;
  }

  /** File 29: checklist templates, one per template_code (ADR 020); re-imports update them. */
  private async checklists() {
    const groups = new Map<string, Bundle['checklistTemplates']>();
    for (const t of this.b.checklistTemplates) {
      groups.set(t.template_code, [...(groups.get(t.template_code) ?? []), t]);
    }
    for (const [code, rows] of groups) {
      const first = rows[0]!;
      this.step(FILES.checklistTemplates.file, first.line);
      const node = this.nodes.get(first.place_code);
      const assign = JSON.stringify(this.assignJson(first.assign_to));
      const steps = JSON.stringify(
        [...rows]
          .sort((a, b) => a.step - b.step)
          .map((r) => ({
            label: r.step_label,
            kind: r.step_kind,
            ...(r.min !== undefined && { min: r.min }),
            ...(r.max !== undefined && { max: r.max }),
            ...(r.unit !== undefined && { unit: r.unit }),
            ...(r.photo_required && { photo_required: true }),
          })),
      );
      const schedule = JSON.stringify(first.schedule);
      // the rules the app's checklist editor applies
      await this.c.query(
        `select ops.check_schedule($1), ops.check_steps($2), ops.check_assign($3, $4)`,
        [schedule, steps, node, assign],
      );
      await this.upsert(
        'checklists',
        `insert into ops.checklist_template as t (tenant_id, org_node_id, code, name, schedule,
                                                 assign, steps)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id, code) where code is not null do update
            set org_node_id = excluded.org_node_id, name = excluded.name,
                schedule = excluded.schedule, assign = excluded.assign, steps = excluded.steps,
                archived_at = null
          where (t.org_node_id, t.name, t.schedule, t.assign, t.steps, t.archived_at)
                is distinct from (excluded.org_node_id, excluded.name, excluded.schedule,
                                  excluded.assign, excluded.steps, null)
         returning id, xmax = 0 as inserted`,
        [this.tenant, node, code, first.name, schedule, assign, steps],
      );
    }
  }

  /** File 30: one-off tasks, created (and, with done_by, finished) as the people named. */
  private async tasks() {
    for (const t of this.b.tasks) {
      this.step(FILES.tasks.file, t.line);
      const key = `test-data task ${t.place_code} ${t.title}`;
      const existed = await this.c.query(
        `select 1 from ops.task where tenant_id = $1 and idempotency_key = $2`,
        [this.tenant, key],
      );
      const steps = (t.steps ?? '')
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((label) => ({ label, kind: 'tick' }));
      const id = await this.as(t.created_by, async () => {
        const r = await this.c.query<{ id: string }>(
          `select ops.create_task($1, $2, $3, ($4::date + $5::time) at time zone $6, $7, $8, $9,
                                  $10) as id`,
          [
            this.nodes.get(t.place_code),
            t.title,
            t.description ?? null,
            this.day(t.day),
            t.due_time,
            this.timezoneOf(t.place_code),
            t.priority,
            JSON.stringify(this.assignJson(t.assign_to)),
            JSON.stringify(steps),
            key,
          ],
        );
        return r.rows[0]!.id;
      });
      this.count('tasks', !existed.rowCount);
      if (existed.rowCount || t.done_by === undefined) continue;
      await this.as(t.done_by, async () => {
        const s = await this.c.query<{ id: string }>(
          `select id from ops.task_step where task_id = $1 order by position`,
          [id],
        );
        for (const step of s.rows) {
          await this.c.query(`select ops.complete_step($1, $2, '{"done": true}')`, [id, step.id]);
        }
        await this.c.query(`select ops.complete_task($1)`, [id]);
      });
    }
  }

  /** File 31: maintenance requests, raised (and assigned) as the people named. */
  private async maintenance() {
    for (const m of this.b.maintenance) {
      this.step(FILES.maintenance.file, m.line);
      const key = `test-data maintenance ${m.place_code} ${m.title}`;
      const existed = await this.c.query(
        `select 1 from ops.maintenance_request where tenant_id = $1 and idempotency_key = $2`,
        [this.tenant, key],
      );
      const id = await this.as(m.reported_by, async () => {
        const r = await this.c.query<{ id: string }>(
          `select ops.raise_maintenance($1, $2, $3, null, $4) as id`,
          [this.nodes.get(m.place_code), m.title, m.description ?? null, key],
        );
        return r.rows[0]!.id;
      });
      this.count('maintenance requests', !existed.rowCount);
      if (existed.rowCount || m.assigned_to === undefined || m.assigned_by === undefined) continue;
      await this.as(m.assigned_by, () =>
        this.c.query(`select ops.assign_maintenance($1, $2)`, [id, this.users.get(m.assigned_to!)]),
      );
    }
  }

  /**
   * File 32: prep tasks set on past days, before the batches of file 26 are recorded; a
   * batch made at the same store, of the same item, on the same day completes its task.
   */
  /**
   * File 32: prep tasks, days counted from `base` (the day files 26 to 28 were loaded),
   * each once: the task keeps a key naming its line.
   */
  private async prepTasks(baseOf: (store: string) => string = () => this.today) {
    for (const p of this.b.prepTasks) {
      this.step(FILES.prepTasks.file, p.line);
      const key = `test-data prep ${p.store_node_code} ${p.prep_item_code} ${p.day}`;
      const map = `${p.store_node_code} ${p.prep_item_code} ${p.day}`;
      const had = await this.c.query<{ id: string }>(
        `select id from ops.task where tenant_id = $1 and kind = 'prep' and idempotency_key = $2`,
        [this.tenant, key],
      );
      if (had.rows[0]) {
        this.prepTaskIds.set(map, had.rows[0].id);
        this.count('prep tasks', false);
        continue;
      }
      const ids = await this.as(p.created_by, async () => {
        const r = await this.c.query<{ ids: string[] }>(
          `select ops.create_prep_tasks($1, $2, ($3::date + $4::time) at time zone $5, $6) as ids`,
          [
            this.nodes.get(p.store_node_code),
            JSON.stringify([{ item_id: this.items.get(p.prep_item_code), qty: p.quantity }]),
            this.day(p.day, baseOf(p.store_node_code)),
            p.due_time,
            this.timezoneOf(p.store_node_code),
            JSON.stringify(this.assignJson(p.assign_to)),
          ],
        );
        return r.rows[0]!.ids;
      });
      await this.c.query(`update ops.task set idempotency_key = $1 where id = $2`, [key, ids[0]]);
      this.prepTaskIds.set(map, ids[0]!);
      this.count('prep tasks', true);
    }
  }

  /**
   * Each store's day for files 26 and 32: the day its batches were loaded, from their
   * keys. A store with none loaded yet has no entry.
   */
  private async storeBases(): Promise<Map<string, string>> {
    const bases = new Map<string, string>();
    const stores = [...new Set(this.b.production.map((p) => p.store_node_code))];
    for (const store of stores) {
      const rows = this.b.production.filter((p) => p.store_node_code === store);
      const first = rows[0]!;
      const { rows: found } = await this.c.query<{ k: string }>(
        `select idempotency_key as k from inv.production
          where tenant_id = $1 and idempotency_key like $2`,
        [this.tenant, `test-data % ${first.time} ${store} ${first.prep_item_code}`],
      );
      // the candidate day under which most of the store's rows are found
      let best: { base: string; n: number } | null = null;
      for (const { k } of found) {
        const base = this.day(-first.day, k.split(' ')[1]);
        const keys = rows.map(
          (p) => `test-data ${this.day(p.day, base)} ${p.time} ${store} ${p.prep_item_code}`,
        );
        const n = (
          await this.c.query(
            `select 1 from inv.production where tenant_id = $1 and idempotency_key = any ($2)`,
            [this.tenant, keys],
          )
        ).rowCount!;
        if (!best || n > best.n) best = { base, n };
      }
      if (best) bases.set(store, best.base);
    }
    return bases;
  }

  /** Links the batches loaded earlier (file 26) to the prep tasks they fulfil (file 32). */
  private async linkPastBatches(baseOf: (store: string) => string) {
    for (const p of this.b.production) {
      const task = this.prepTaskIds.get(`${p.store_node_code} ${p.prep_item_code} ${p.day}`);
      if (!task) continue;
      const key = `test-data ${this.day(p.day, baseOf(p.store_node_code))} ${p.time} ${p.store_node_code} ${p.prep_item_code}`;
      const made = await this.c.query<{ id: string }>(
        `select id from inv.production
          where tenant_id = $1 and idempotency_key = $2 and task_id is null`,
        [this.tenant, key],
      );
      if (made.rows[0]) {
        this.step(FILES.production.file, p.line);
        await this.c.query(`select ops.link_test_batch($1, $2)`, [task, made.rows[0].id]);
      }
    }
  }

  /** A place's time zone: its own, else the nearest parent's, else the customer's. */
  private timezoneOf(code: string): string {
    const rows = [...this.b.orgNodes, ...this.b.deliveryNodes];
    for (let n = rows.find((x) => x.node_code === code); n;) {
      if (n.timezone) return n.timezone;
      const parent = n.parent_code;
      n = parent ? rows.find((x) => x.node_code === parent) : undefined;
    }
    return this.b.customer[0]!.default_timezone;
  }

  private async preview(): Promise<AccessRow[]> {
    const { rows } = await this.c.query<AccessRow>(
      `select u.username, u.display_name, g.code as access_group, n.code as node_code,
              n.name as place_name,
              case when ra.include_descendants then 'this place and everything below'
                   else 'this place only' end as covers,
              case ra.source when 'extra' then 'extra (file 08)'
                             when 'job_role' then ra.source_note
                             else 'manual' end as source
         from core.role_assignment ra
         join core.app_user u on u.id = ra.user_id
         join core.security_group g on g.id = ra.group_id
         join core.hierarchy_node n on n.id = ra.node_id
        where ra.tenant_id = $1 and u.status = 'active' and u.username = any ($2)
          and (ra.effective_to is null or ra.effective_to >= current_date)
        order by u.username, g.code, n.code`,
      [this.tenant, this.b.users.map((u) => u.username)],
    );
    return rows;
  }
}

function sortKeys(o: Record<string, string>): [string, string][] {
  return Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
}
