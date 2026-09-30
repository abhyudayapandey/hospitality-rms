import { syncProcessDefs, syncProductAccess } from '@outlet-ops/workflow';
import type { ClientBase } from 'pg';
import { FILES, readBundle, type Bundle, type Issue } from './files';
import { validateBundle } from './validate';

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
    if (opts.nested) await client.query('release savepoint onboarding');
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
  private nodes = new Map<string, string>();
  private users = new Map<string, string>();
  private workers = new Map<string, string>();
  private suppliers = new Map<string, string>();
  private items = new Map<string, string>();
  private leaveTypes = new Map<string, string>();

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
    await this.structure();
    await this.people();
    if (this.report.issues.length) return;
    await this.access();
    await this.coverage();
    if (this.report.issues.length) return;
    await this.stock();
    await this.leave();
    await this.rostering();
    await this.events();
    this.step('');
    this.report.access = await this.preview();
  }

  private async customer() {
    const cu = this.b.customer[0]!;
    this.step(FILES.customer.file, cu.line);
    this.report.customer = cu.customer_code;
    await this.upsert(
      'customer',
      `insert into core.tenant (name, code, country, currency, default_timezone)
       values ($1, $2, $3, $4, $5)
       on conflict (code) where code is not null do update
          set name = excluded.name, country = excluded.country, currency = excluded.currency,
              default_timezone = excluded.default_timezone
        where (core.tenant.name, core.tenant.country, core.tenant.currency,
               core.tenant.default_timezone)
              is distinct from (excluded.name, excluded.country, excluded.currency,
                                excluded.default_timezone)
       returning id, xmax = 0 as inserted`,
      [cu.company_name, cu.customer_code, cu.country, cu.currency, cu.default_timezone],
    );
    this.tenant = (
      await this.c.query<{ id: string }>(`select id from core.tenant where code = $1`, [
        cu.customer_code,
      ])
    ).rows[0]!.id;
    this.report.tenantId = this.tenant;
    if (cu.leave_hr_approval !== undefined) {
      await this.c.query(
        `update core.tenant set settings = settings || jsonb_build_object('leave_hr_approval', $2::boolean)
          where id = $1 and (settings ->> 'leave_hr_approval')::boolean is distinct from $2`,
        [this.tenant, cu.leave_hr_approval],
      );
    }
    // groups, domains and the policy matrix the assignments below refer to
    await syncProductAccess(this.c, this.tenant);
    await syncProcessDefs(this.c);
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
                                            outlet_format, holds_stock, is_main_store)
           values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, false), coalesce($10, false))
           on conflict (tenant_id, code) where code is not null do update
              set name = excluded.name, kind = excluded.kind, parent_id = excluded.parent_id,
                  timezone = excluded.timezone, outlet_format = excluded.outlet_format,
                  holds_stock = excluded.holds_stock, is_main_store = excluded.is_main_store,
                  archived_at = null
            where (core.hierarchy_node.name, core.hierarchy_node.kind,
                   core.hierarchy_node.parent_id, core.hierarchy_node.timezone,
                   core.hierarchy_node.outlet_format, core.hierarchy_node.holds_stock,
                   core.hierarchy_node.is_main_store, core.hierarchy_node.archived_at)
                  is distinct from (excluded.name, excluded.kind, excluded.parent_id,
                                    excluded.timezone, excluded.outlet_format,
                                    excluded.holds_stock, excluded.is_main_store, null)
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
      await this.upsert(
        'location settings',
        `insert into hr.node_setting (tenant_id, org_node_id, latitude, longitude, geofence_radius_m)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, org_node_id) do update
            set latitude = excluded.latitude, longitude = excluded.longitude,
                geofence_radius_m = excluded.geofence_radius_m
          where (hr.node_setting.latitude, hr.node_setting.longitude,
                 hr.node_setting.geofence_radius_m)
                is distinct from (excluded.latitude, excluded.longitude, excluded.geofence_radius_m)
         returning id, xmax = 0 as inserted`,
        [
          this.tenant,
          this.nodes.get(s.org_node_code),
          s.latitude,
          s.longitude,
          s.geofence_radius_m,
        ],
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

  private async access() {
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

  private async stock() {
    const cu = this.b.customer[0]!;
    for (const s of this.b.suppliers) {
      this.step(FILES.suppliers.file, s.line);
      await this.upsert(
        'suppliers',
        `insert into inv.supplier (tenant_id, code, name, lead_time_days, contact)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, code) where code is not null do update
            set name = excluded.name, lead_time_days = excluded.lead_time_days,
                contact = excluded.contact, archived_at = null
          where (inv.supplier.name, inv.supplier.lead_time_days, inv.supplier.contact,
                 inv.supplier.archived_at)
                is distinct from (excluded.name, excluded.lead_time_days, excluded.contact, null)
         returning id, xmax = 0 as inserted`,
        [this.tenant, s.supplier_code, s.name, s.lead_time_days, s.contact_email ?? null],
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
                                        late_threshold_min)
         values ($1, coalesce($2, 10), coalesce($3, 48), coalesce($4, 10))
         on conflict (tenant_id) do update
            set min_rest_hours = excluded.min_rest_hours,
                weekly_hours_cap = excluded.weekly_hours_cap,
                late_threshold_min = excluded.late_threshold_min
          where (hr.roster_setting.min_rest_hours, hr.roster_setting.weekly_hours_cap,
                 hr.roster_setting.late_threshold_min)
                is distinct from (excluded.min_rest_hours, excluded.weekly_hours_cap,
                                  excluded.late_threshold_min)
         returning id, xmax = 0 as inserted`,
        [this.tenant, v('min_rest_hours'), v('weekly_hours_cap'), v('late_threshold_min')],
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
