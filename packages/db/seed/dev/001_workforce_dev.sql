-- DEV SEED ONLY, run after the test customers are loaded (docs/onboarding/test-data): the
-- activity onboarding files do not carry. Idempotent: shifts are keyed by (template,
-- date), so re-seeding in a later week adds that week's shifts.
--
--   * every shift template gets this week's shifts (published) and next week's (draft;
--     the test shifts file 25 has already published next week's for the places it covers);
--     each worker works their role's template at their home place from Monday, one shift
--     a day, on as many weekdays (at most five) as the weekly-hours cap allows
--   * pay rates for the Test Bar 3.0 team
--   * punches for this week's past shifts at Test Bar 3.0, then the nightly job, so the
--     exceptions queue has content: the server is 12 minutes late on their first shift,
--     the host misses theirs, the cook forgets to clock out once

insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                      role_code, headcount, status, published_at)
select t.tenant_id, t.org_node_id, t.id, d.day,
       (d.day + t.start_time) at time zone tz.tz,
       (d.day + case when t.end_time > t.start_time then 0 else 1 end + t.end_time)
         at time zone tz.tz,
       t.role_code, t.headcount,
       case when w.n = 0 then 'published' else 'draft' end,
       case when w.n = 0 then now() end
  from hr.shift_template t
  join core.tenant ten on ten.id = t.tenant_id and ten.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY')
 cross join lateral (
   select coalesce((select n.timezone from core.self_and_ancestors(t.org_node_id) a
                      join core.hierarchy_node n on n.id = a.id
                     where n.timezone is not null order by a.depth desc limit 1),
                   ten.default_timezone) as tz) tz
 cross join (values (0), (1)) w(n)
 cross join lateral (
   select hr.week_start((now() at time zone tz.tz)::date) + 7 * w.n + i as day
     from generate_series(0, 6) i) d
 where t.archived_at is null
   and extract(isodow from d.day)::int = any (t.weekdays)
on conflict (template_id, local_date) where template_id is not null and status <> 'cancelled'
do nothing;

-- each worker's template: the earliest one for their role at their home place
insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                 start_at, end_at)
select c.tenant_id, c.shift_id, c.worker_id, c.owner_user_id, c.org_node_id, c.start_at, c.end_at
  from (
    select s.tenant_id, s.id as shift_id, w.id as worker_id, w.owner_user_id, s.org_node_id,
           s.start_at, s.end_at,
           s.headcount - (select count(*) from hr.shift_assignment a
                           where a.shift_id = s.id and a.status = 'assigned') as open_slots,
           row_number() over (partition by s.id order by w.id) as rn
      from hr.worker w
      join core.tenant ten on ten.id = w.tenant_id
                          and ten.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY')
      join lateral (
        select t.id from hr.shift_template t
         where t.org_node_id = w.org_node_id and t.role_code = w.role_code
           and t.archived_at is null
         order by t.start_time, t.name limit 1) t on true
      join hr.shift s on s.template_id = t.id
     -- Monday to Friday, fewer days for long shifts so the weekly cap holds
     where extract(isodow from s.local_date)::int <= least(5, floor(
             coalesce((select r.weekly_hours_cap from hr.roster_setting r
                        where r.tenant_id = s.tenant_id), 48)
             / (extract(epoch from s.end_at - s.start_at) / 3600)))
       and s.local_date between hr.week_start((now() at time zone 'Asia/Kolkata')::date)
                            and hr.week_start((now() at time zone 'Asia/Kolkata')::date) + 13
       and not exists (select 1 from hr.shift_assignment a
                        where a.shift_id = s.id and a.worker_id = w.id)
       -- a worker already rostered that week (the test shifts file 25, or an earlier
       -- seed) is left as they are
       and not exists (select 1 from hr.shift_assignment a
                        where a.worker_id = w.id and a.status = 'assigned'
                          and hr.week_start((a.start_at at time zone 'Asia/Kolkata')::date)
                              = hr.week_start(s.local_date))
       -- respect approved leave if any was granted in the app since the last seed
       and not exists (select 1 from hr.leave_request l
                        where l.worker_id = w.id and l.status = 'approved'
                          and s.local_date between l.from_date and l.to_date)) c
 where c.rn <= c.open_slots;

-- Pay rates come from the test customers' file 34 (ADR 030).

with u as (
  select w.id, a.username
    from hr.worker w join core.app_user a on a.id = w.owner_user_id
   where a.username in ('test.server.3.0', 'test.host.3.0', 'test.cook.3.0'))
insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, shift_id,
                           clock_in_at, clock_out_at, in_source, out_source, in_key, out_key,
                           in_lat, in_lng, in_distance_m, in_inside,
                           out_lat, out_lng, out_distance_m, out_inside)
select a.tenant_id, a.worker_id, a.owner_user_id, a.org_node_id, a.shift_id,
       a.start_at + case when a.username = 'test.server.3.0' and a.first
                         then interval '12 minutes' else interval '-5 minutes' end,
       case when a.open then null else a.end_at + interval '3 minutes' end,
       'online',
       case when a.open then null else 'online' end,
       'seed-in-' || a.shift_id,
       case when a.open then null else 'seed-out-' || a.shift_id end,
       ns.latitude, ns.longitude, 0, true,
       case when a.open then null else ns.latitude end,
       case when a.open then null else ns.longitude end,
       case when a.open then null else 0 end,
       case when a.open then null else true end
  from (select sa.*, u.username,
               row_number() over (partition by sa.worker_id order by sa.start_at) = 1 as first,
               u.username = 'test.cook.3.0'
                 and row_number() over (partition by sa.worker_id order by sa.start_at) = 1 as open
          from hr.shift_assignment sa
          join u on u.id = sa.worker_id
          join hr.shift s on s.id = sa.shift_id and s.status = 'published'
         where sa.status = 'assigned' and sa.end_at < now()
           and s.local_date >= hr.week_start((now() at time zone 'Asia/Kolkata')::date)) a
 cross join lateral (select * from hr.geofence_for(a.org_node_id)) ns
 where not (a.username = 'test.host.3.0' and a.first)
   and not exists (select 1 from hr.attendance x where x.worker_id = a.worker_id and x.shift_id = a.shift_id)
   -- one open punch per worker at most
   and not (a.open and exists (select 1 from hr.attendance x
                                where x.worker_id = a.worker_id and x.clock_out_at is null));

select * from hr.nightly_attendance(now(), 7);
