-- DEV SEED ONLY: workforce data for the demo tenant (ADR 008). Production workers, shift
-- templates, leave entitlements, geofences and rules come from the pilot onboarding
-- script. Idempotent: fixed ids and upserts; shifts are keyed by (template, date), so
-- re-seeding in a later week adds that week's shifts.
--
-- 12 workers: Outlet A 5, Outlet B 4, Hub site 3. This week's shifts are published and
-- next week's are a draft (for the manager to adjust and publish). Past days this week
-- get punches, then the nightly job runs so the exceptions queue has content.

-- ---------------------------------------------------------------------------
-- Users: the new workers, an Outlet B manager and a Hub site supervisor (org tree only,
-- so inventory routing on the delivery tree is unchanged)
-- ---------------------------------------------------------------------------

insert into core.app_user (id, tenant_id, kind, display_name) values
  ('01920000-0000-7000-8000-000000000311', '01920000-0000-7000-8000-000000000001', 'human', 'Priya Server'),
  ('01920000-0000-7000-8000-000000000312', '01920000-0000-7000-8000-000000000001', 'human', 'Omar Outlet B Manager'),
  ('01920000-0000-7000-8000-000000000313', '01920000-0000-7000-8000-000000000001', 'human', 'Bea Server'),
  ('01920000-0000-7000-8000-000000000314', '01920000-0000-7000-8000-000000000001', 'human', 'Ravi Cook'),
  ('01920000-0000-7000-8000-000000000315', '01920000-0000-7000-8000-000000000001', 'human', 'Nisha Cleaner'),
  ('01920000-0000-7000-8000-000000000316', '01920000-0000-7000-8000-000000000001', 'human', 'Hana Hub Supervisor'),
  ('01920000-0000-7000-8000-000000000317', '01920000-0000-7000-8000-000000000001', 'human', 'Arjun Storekeeper'),
  ('01920000-0000-7000-8000-000000000318', '01920000-0000-7000-8000-000000000001', 'human', 'Lata Cleaner')
on conflict (id) do nothing;

insert into core.role_assignment (tenant_id, user_id, group_id, node_id, include_descendants, effective_from)
select '01920000-0000-7000-8000-000000000001', a.user_id::uuid, g.id, a.node_id::uuid, true, date '2026-01-01'
  from (values
    ('01920000-0000-7000-8000-000000000311', 'STAFF',          '01920000-0000-7000-8000-000000000104'),
    ('01920000-0000-7000-8000-000000000312', 'STAFF',          '01920000-0000-7000-8000-000000000105'),
    ('01920000-0000-7000-8000-000000000312', 'OUTLET_MANAGER', '01920000-0000-7000-8000-000000000105'),
    ('01920000-0000-7000-8000-000000000313', 'STAFF',          '01920000-0000-7000-8000-000000000105'),
    ('01920000-0000-7000-8000-000000000314', 'STAFF',          '01920000-0000-7000-8000-000000000105'),
    ('01920000-0000-7000-8000-000000000315', 'STAFF',          '01920000-0000-7000-8000-000000000105'),
    ('01920000-0000-7000-8000-000000000316', 'STAFF',          '01920000-0000-7000-8000-000000000106'),
    ('01920000-0000-7000-8000-000000000316', 'OUTLET_MANAGER', '01920000-0000-7000-8000-000000000106'),
    ('01920000-0000-7000-8000-000000000317', 'STAFF',          '01920000-0000-7000-8000-000000000106'),
    ('01920000-0000-7000-8000-000000000318', 'STAFF',          '01920000-0000-7000-8000-000000000106')
  ) as a(user_id, grp, node_id)
  join core.security_group g on g.code = a.grp and g.tenant_id = '01920000-0000-7000-8000-000000000001'
on conflict (user_id, group_id, node_id, effective_from) do nothing;

-- ---------------------------------------------------------------------------
-- Config: job roles, rostering rules (the defaults, made explicit), geofences
-- ---------------------------------------------------------------------------

insert into hr.job_role (tenant_id, code, name)
select '01920000-0000-7000-8000-000000000001', code, name from (values
  ('MANAGER', 'Manager'), ('SERVER', 'Server'), ('COOK', 'Cook'),
  ('STORE', 'Storekeeper'), ('CLEANER', 'Cleaner')) r(code, name)
on conflict (tenant_id, code) do update set name = excluded.name;

insert into hr.roster_setting (tenant_id, min_rest_hours, weekly_hours_cap, late_threshold_min)
values ('01920000-0000-7000-8000-000000000001', 10, 48, 10)
on conflict (tenant_id) do nothing;

insert into hr.node_setting (tenant_id, org_node_id, latitude, longitude, geofence_radius_m) values
  ('01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000104', 12.971600, 77.594600, 150),
  ('01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000105', 12.935200, 77.624500, 150),
  ('01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000106', 13.035800, 77.597000, 150)
on conflict (tenant_id, org_node_id) do update
   set latitude = excluded.latitude, longitude = excluded.longitude,
       geofence_radius_m = excluded.geofence_radius_m;

-- ---------------------------------------------------------------------------
-- Workers (12) and optional pay rates
-- ---------------------------------------------------------------------------

insert into hr.worker (id, tenant_id, owner_user_id, org_node_id, role_code, employment_type, joined_on)
select w.id::uuid, '01920000-0000-7000-8000-000000000001', w.user_id::uuid, w.node::uuid, w.role,
       w.emp, date '2025-06-01'
  from (values
    -- Outlet A
    ('01920000-0000-7000-8000-000000000701', '01920000-0000-7000-8000-000000000304', '01920000-0000-7000-8000-000000000104', 'MANAGER', 'full_time'),
    ('01920000-0000-7000-8000-000000000702', '01920000-0000-7000-8000-000000000301', '01920000-0000-7000-8000-000000000104', 'SERVER',  'full_time'),
    ('01920000-0000-7000-8000-000000000703', '01920000-0000-7000-8000-000000000311', '01920000-0000-7000-8000-000000000104', 'SERVER',  'part_time'),
    ('01920000-0000-7000-8000-000000000704', '01920000-0000-7000-8000-000000000302', '01920000-0000-7000-8000-000000000104', 'COOK',    'full_time'),
    ('01920000-0000-7000-8000-000000000705', '01920000-0000-7000-8000-000000000303', '01920000-0000-7000-8000-000000000104', 'STORE',   'full_time'),
    -- Outlet B
    ('01920000-0000-7000-8000-000000000706', '01920000-0000-7000-8000-000000000312', '01920000-0000-7000-8000-000000000105', 'MANAGER', 'full_time'),
    ('01920000-0000-7000-8000-000000000707', '01920000-0000-7000-8000-000000000313', '01920000-0000-7000-8000-000000000105', 'SERVER',  'full_time'),
    ('01920000-0000-7000-8000-000000000708', '01920000-0000-7000-8000-000000000314', '01920000-0000-7000-8000-000000000105', 'COOK',    'full_time'),
    ('01920000-0000-7000-8000-000000000709', '01920000-0000-7000-8000-000000000315', '01920000-0000-7000-8000-000000000105', 'CLEANER', 'casual'),
    -- Hub site
    ('01920000-0000-7000-8000-000000000710', '01920000-0000-7000-8000-000000000316', '01920000-0000-7000-8000-000000000106', 'MANAGER', 'full_time'),
    ('01920000-0000-7000-8000-000000000711', '01920000-0000-7000-8000-000000000317', '01920000-0000-7000-8000-000000000106', 'STORE',   'full_time'),
    ('01920000-0000-7000-8000-000000000712', '01920000-0000-7000-8000-000000000318', '01920000-0000-7000-8000-000000000106', 'CLEANER', 'part_time')
  ) as w(id, user_id, node, role, emp)
on conflict (id) do update
   set org_node_id = excluded.org_node_id, role_code = excluded.role_code,
       employment_type = excluded.employment_type, status = 'active';

insert into hr.worker_sensitive (tenant_id, worker_id, owner_user_id, org_node_id, pay_rate, pay_basis)
select w.tenant_id, w.id, w.owner_user_id, w.org_node_id,
       case w.employment_type when 'full_time' then 24000 else 160 end,
       case w.employment_type when 'full_time' then 'monthly' else 'hourly' end
  from hr.worker w
 where w.tenant_id = '01920000-0000-7000-8000-000000000001'
on conflict (worker_id) do nothing;

-- ---------------------------------------------------------------------------
-- Shift templates, and the fixed pattern used to fill them
-- ---------------------------------------------------------------------------

insert into hr.shift_template (id, tenant_id, org_node_id, name, role_code, start_time, end_time,
                               headcount, weekdays)
select t.id::uuid, '01920000-0000-7000-8000-000000000001', t.node::uuid, t.name, t.role,
       t.s::time, t.e::time, t.hc, t.days::int[]
  from (values
    ('01920000-0000-7000-8000-000000000801', '01920000-0000-7000-8000-000000000104', 'Breakfast floor', 'SERVER',  '07:00', '15:00', 2, '{1,2,3,4,5,6,7}'),
    ('01920000-0000-7000-8000-000000000802', '01920000-0000-7000-8000-000000000104', 'Dinner floor',    'SERVER',  '15:00', '23:00', 2, '{1,2,3,4,5,6,7}'),
    ('01920000-0000-7000-8000-000000000803', '01920000-0000-7000-8000-000000000104', 'Kitchen',         'COOK',    '09:00', '17:00', 1, '{1,2,3,4,5,6}'),
    ('01920000-0000-7000-8000-000000000804', '01920000-0000-7000-8000-000000000104', 'Stores',          'STORE',   '08:00', '16:00', 1, '{1,2,3,4,5,6}'),
    ('01920000-0000-7000-8000-000000000805', '01920000-0000-7000-8000-000000000104', 'Manager on duty', 'MANAGER', '10:00', '18:00', 1, '{1,2,3,4,5}'),
    ('01920000-0000-7000-8000-000000000806', '01920000-0000-7000-8000-000000000105', 'Floor',           'SERVER',  '11:00', '19:00', 1, '{1,2,3,4,5,6,7}'),
    ('01920000-0000-7000-8000-000000000807', '01920000-0000-7000-8000-000000000105', 'Kitchen',         'COOK',    '10:00', '18:00', 1, '{1,2,3,4,5,6}'),
    ('01920000-0000-7000-8000-000000000808', '01920000-0000-7000-8000-000000000105', 'Cleaning',        'CLEANER', '06:00', '14:00', 1, '{1,2,3,4,5,6}'),
    ('01920000-0000-7000-8000-000000000809', '01920000-0000-7000-8000-000000000105', 'Manager on duty', 'MANAGER', '10:00', '18:00', 1, '{1,2,3,4,5}'),
    ('01920000-0000-7000-8000-000000000810', '01920000-0000-7000-8000-000000000106', 'Receiving',       'STORE',   '06:00', '14:00', 1, '{1,2,3,4,5,6}'),
    ('01920000-0000-7000-8000-000000000811', '01920000-0000-7000-8000-000000000106', 'Cleaning',        'CLEANER', '14:00', '22:00', 1, '{1,2,3,4,5,6}'),
    ('01920000-0000-7000-8000-000000000812', '01920000-0000-7000-8000-000000000106', 'Supervisor',      'MANAGER', '08:00', '16:00', 1, '{1,2,3,4,5}')
  ) as t(id, node, name, role, s, e, hc, days)
on conflict (id) do update
   set name = excluded.name, role_code = excluded.role_code, start_time = excluded.start_time,
       end_time = excluded.end_time, headcount = excluded.headcount, weekdays = excluded.weekdays;

-- Who works which template on which ISO weekdays. Every pattern keeps the rules: one
-- shift a day, at least 10 h rest, at most 40 h a week.
drop table if exists pg_temp.seed_pattern;
create temp table seed_pattern (worker uuid, template uuid, days int[]);
insert into seed_pattern values
  ('01920000-0000-7000-8000-000000000701', '01920000-0000-7000-8000-000000000805', '{1,2,3,4,5}'),
  ('01920000-0000-7000-8000-000000000702', '01920000-0000-7000-8000-000000000801', '{1,2,3,4,5}'),
  ('01920000-0000-7000-8000-000000000703', '01920000-0000-7000-8000-000000000802', '{2,3,4,5,6}'),
  ('01920000-0000-7000-8000-000000000704', '01920000-0000-7000-8000-000000000803', '{1,2,3,4,5}'),
  ('01920000-0000-7000-8000-000000000705', '01920000-0000-7000-8000-000000000804', '{1,2,3,4,5}'),
  ('01920000-0000-7000-8000-000000000706', '01920000-0000-7000-8000-000000000809', '{1,2,3,4,5}'),
  ('01920000-0000-7000-8000-000000000707', '01920000-0000-7000-8000-000000000806', '{1,2,3,4,5}'),
  ('01920000-0000-7000-8000-000000000708', '01920000-0000-7000-8000-000000000807', '{1,2,3,4,5}'),
  ('01920000-0000-7000-8000-000000000709', '01920000-0000-7000-8000-000000000808', '{2,3,4,5,6}'),
  ('01920000-0000-7000-8000-000000000710', '01920000-0000-7000-8000-000000000812', '{1,2,3,4,5}'),
  ('01920000-0000-7000-8000-000000000711', '01920000-0000-7000-8000-000000000810', '{1,2,3,4,5}'),
  ('01920000-0000-7000-8000-000000000712', '01920000-0000-7000-8000-000000000811', '{1,2,3,4,5}');

-- ---------------------------------------------------------------------------
-- Two weeks of shifts: this week (published) and next week (draft), in Asia/Kolkata
-- ---------------------------------------------------------------------------

insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                      role_code, headcount, status, published_at)
select t.tenant_id, t.org_node_id, t.id, d.day,
       (d.day + t.start_time) at time zone 'Asia/Kolkata',
       (d.day + case when t.end_time > t.start_time then 0 else 1 end + t.end_time) at time zone 'Asia/Kolkata',
       t.role_code, t.headcount,
       case when w.n = 0 then 'published' else 'draft' end,
       case when w.n = 0 then now() end
  from hr.shift_template t
 cross join (values (0), (1)) w(n)
 cross join lateral (
   select hr.week_start((now() at time zone 'Asia/Kolkata')::date) + 7 * w.n + i as day
     from generate_series(0, 6) i) d
 where t.tenant_id = '01920000-0000-7000-8000-000000000001' and t.archived_at is null
   and extract(isodow from d.day)::int = any (t.weekdays)
on conflict (template_id, local_date) where template_id is not null do nothing;

insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                 start_at, end_at)
select s.tenant_id, s.id, w.id, w.owner_user_id, s.org_node_id, s.start_at, s.end_at
  from seed_pattern p
  join hr.worker w on w.id = p.worker
  join hr.shift s on s.template_id = p.template
 where extract(isodow from s.local_date)::int = any (p.days)
   and s.local_date between hr.week_start((now() at time zone 'Asia/Kolkata')::date)
                        and hr.week_start((now() at time zone 'Asia/Kolkata')::date) + 13
   and not exists (select 1 from hr.shift_assignment a where a.shift_id = s.id and a.worker_id = w.id)
   -- respect approved leave if any was granted in the app since the last seed
   and not exists (select 1 from hr.leave_request l
                    where l.worker_id = w.id and l.status = 'approved'
                      and s.local_date between l.from_date and l.to_date);

drop table pg_temp.seed_pattern;

-- ---------------------------------------------------------------------------
-- Leave types and this year's balances
-- ---------------------------------------------------------------------------

insert into hr.leave_type (id, tenant_id, code, name, annual_days) values
  ('01920000-0000-7000-8000-000000000901', '01920000-0000-7000-8000-000000000001', 'ANNUAL', 'Annual leave', 18),
  ('01920000-0000-7000-8000-000000000902', '01920000-0000-7000-8000-000000000001', 'SICK', 'Sick leave', 12),
  ('01920000-0000-7000-8000-000000000903', '01920000-0000-7000-8000-000000000001', 'CASUAL', 'Casual leave', 6),
  ('01920000-0000-7000-8000-000000000904', '01920000-0000-7000-8000-000000000001', 'UNPAID', 'Unpaid leave', null)
on conflict (id) do update set name = excluded.name, annual_days = excluded.annual_days;

insert into hr.leave_balance (tenant_id, worker_id, owner_user_id, org_node_id, leave_type_id,
                              year, entitled_days, used_days)
select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, t.id, y.year, t.annual_days,
       case when t.code = 'ANNUAL' then 3 when t.code = 'SICK' then 1 else 0 end
  from hr.worker w
  join hr.leave_type t on t.tenant_id = w.tenant_id and t.annual_days is not null
 cross join (select extract(year from now() at time zone 'Asia/Kolkata')::int as year
             union select extract(year from now() at time zone 'Asia/Kolkata')::int + 1) y
 where w.tenant_id = '01920000-0000-7000-8000-000000000001'
on conflict (worker_id, leave_type_id, year) do nothing;

-- ---------------------------------------------------------------------------
-- Three upcoming events with requirements (times relative to the seed date)
-- ---------------------------------------------------------------------------

insert into ops.event (id, tenant_id, org_node_id, name, starts_at, ends_at, covers, status, notes)
select e.id::uuid, '01920000-0000-7000-8000-000000000001', e.node::uuid, e.name,
       (hr.week_start((now() at time zone 'Asia/Kolkata')::date) + e.day + e.s::time) at time zone 'Asia/Kolkata',
       (hr.week_start((now() at time zone 'Asia/Kolkata')::date) + e.day + e.e::time) at time zone 'Asia/Kolkata',
       e.covers, e.status, e.notes
  from (values
    ('01920000-0000-7000-8000-000000000951', '01920000-0000-7000-8000-000000000104',
     'Corporate lunch – TechPark', 9, '12:30', '15:30', 80, 'confirmed', 'Veg and non-veg buffet'),
    ('01920000-0000-7000-8000-000000000952', '01920000-0000-7000-8000-000000000105',
     'Birthday dinner – Rao family', 11, '19:30', '23:00', 40, 'planned', 'Cake from outside allowed'),
    ('01920000-0000-7000-8000-000000000953', '01920000-0000-7000-8000-000000000104',
     'Sunday brunch buffet', 13, '10:00', '14:30', 120, 'planned', null)
  ) as e(id, node, name, day, s, e, covers, status, notes)
on conflict (id) do update
   set starts_at = excluded.starts_at, ends_at = excluded.ends_at, covers = excluded.covers,
       status = excluded.status, name = excluded.name, notes = excluded.notes;

insert into ops.event_requirement (id, tenant_id, event_id, org_node_id, kind, item_id, qty,
                                   role_code, headcount, starts_at, ends_at)
select r.id::uuid, ev.tenant_id, ev.id, ev.org_node_id, r.kind, i.id, r.qty, r.role,
       r.hc,
       case when r.kind = 'role' then ev.starts_at - interval '90 minutes' end,
       case when r.kind = 'role' then ev.ends_at + interval '30 minutes' end
  from (values
    ('01920000-0000-7000-8000-000000000961', '01920000-0000-7000-8000-000000000951', 'item', 'DRY-RICE-BAS', 12::numeric, null, null::int),
    ('01920000-0000-7000-8000-000000000962', '01920000-0000-7000-8000-000000000951', 'item', 'DAI-PANEER', 8, null, null),
    ('01920000-0000-7000-8000-000000000963', '01920000-0000-7000-8000-000000000951', 'item', 'MEA-CHK-BL', 10, null, null),
    ('01920000-0000-7000-8000-000000000964', '01920000-0000-7000-8000-000000000951', 'role', null, null, 'SERVER', 4),
    ('01920000-0000-7000-8000-000000000965', '01920000-0000-7000-8000-000000000951', 'role', null, null, 'COOK', 2),
    ('01920000-0000-7000-8000-000000000966', '01920000-0000-7000-8000-000000000952', 'item', 'DAI-CREAM', 3, null, null),
    ('01920000-0000-7000-8000-000000000967', '01920000-0000-7000-8000-000000000952', 'role', null, null, 'SERVER', 2),
    ('01920000-0000-7000-8000-000000000968', '01920000-0000-7000-8000-000000000953', 'item', 'EGG-TRAY', 180, null, null),
    ('01920000-0000-7000-8000-000000000969', '01920000-0000-7000-8000-000000000953', 'item', 'DAI-MILK', 25, null, null),
    ('01920000-0000-7000-8000-000000000970', '01920000-0000-7000-8000-000000000953', 'role', null, null, 'SERVER', 5)
  ) as r(id, event_id, kind, sku, qty, role, hc)
  join ops.event ev on ev.id = r.event_id::uuid
  left join inv.item i on i.sku = r.sku and i.tenant_id = ev.tenant_id
 where r.kind = 'role' or i.id is not null
on conflict (id) do update
   set qty = excluded.qty, headcount = excluded.headcount,
       starts_at = excluded.starts_at, ends_at = excluded.ends_at;

-- ---------------------------------------------------------------------------
-- Punches for this week's past shifts, then the nightly job, so Outlet A's exceptions
-- queue has content: Sam is 12 minutes late on his first shift, Priya misses her first
-- shift, Kim forgets to clock out once. Coordinates are the outlet's fence centre.
-- ---------------------------------------------------------------------------

insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, shift_id,
                           clock_in_at, clock_out_at, in_source, out_source, in_key, out_key,
                           in_lat, in_lng, in_distance_m, in_inside,
                           out_lat, out_lng, out_distance_m, out_inside)
select a.tenant_id, a.worker_id, a.owner_user_id, a.org_node_id, a.shift_id,
       a.start_at + case when a.worker_id = '01920000-0000-7000-8000-000000000702' and a.first
                         then interval '12 minutes' else interval '-5 minutes' end,
       case when a.worker_id = '01920000-0000-7000-8000-000000000705' and a.first then null
            else a.end_at + interval '3 minutes' end,
       'online',
       case when a.worker_id = '01920000-0000-7000-8000-000000000705' and a.first then null else 'online' end,
       'seed-in-' || a.shift_id,
       case when a.worker_id = '01920000-0000-7000-8000-000000000705' and a.first then null
            else 'seed-out-' || a.shift_id end,
       ns.latitude, ns.longitude, 0, true,
       case when a.worker_id = '01920000-0000-7000-8000-000000000705' and a.first then null else ns.latitude end,
       case when a.worker_id = '01920000-0000-7000-8000-000000000705' and a.first then null else ns.longitude end,
       case when a.worker_id = '01920000-0000-7000-8000-000000000705' and a.first then null else 0 end,
       case when a.worker_id = '01920000-0000-7000-8000-000000000705' and a.first then null else true end
  from (select sa.*, s.start_at as shift_start,
               row_number() over (partition by sa.worker_id order by sa.start_at) = 1 as first
          from hr.shift_assignment sa
          join hr.shift s on s.id = sa.shift_id and s.status = 'published'
         where sa.tenant_id = '01920000-0000-7000-8000-000000000001'
           and sa.status = 'assigned' and sa.end_at < now()
           and s.local_date >= hr.week_start((now() at time zone 'Asia/Kolkata')::date)) a
  join hr.node_setting ns on ns.org_node_id = a.org_node_id
 where not (a.worker_id = '01920000-0000-7000-8000-000000000703' and a.first)
   and not exists (select 1 from hr.attendance x where x.worker_id = a.worker_id and x.shift_id = a.shift_id)
   -- one open punch per worker at most
   and not (a.worker_id = '01920000-0000-7000-8000-000000000705' and a.first
            and exists (select 1 from hr.attendance x
                         where x.worker_id = a.worker_id and x.clock_out_at is null));

select * from hr.nightly_attendance(now(), 7);
