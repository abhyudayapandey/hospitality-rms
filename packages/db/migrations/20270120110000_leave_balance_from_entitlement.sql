-- migrate:up
-- A missing leave balance is the leave type's full year (ADR 167, review H8).
--
-- Only the onboarding loader wrote hr.leave_balance, so nobody had a balance for next year
-- (January's leave was refused from today) and nobody added through People had one at all.
-- Now a person with no balance row for a year has the leave type's annual_days for it: the
-- check when asking (hr.leave_available), the balance on screen (hr.leave_balances) and the
-- "Leave not yet taken" report (rpt.leave_rows) all read it that way, and the row is made, full,
-- the first time leave of that type and year is approved (hr.execute). A file 14 row, where
-- there is one, still wins. No yearly job: a missing row is never wrong, so nothing has to run.

select core.patch_function('hr.leave_available(uuid, uuid, integer, uuid)',
  $x$               where b.worker_id = p_worker and b.leave_type_id = p_type and b.year = p_year), 0)$x$,
  $x$               where b.worker_id = p_worker and b.leave_type_id = p_type and b.year = p_year),
             t.annual_days)$x$);

select core.patch_function('hr.leave_balances(uuid, integer)',
  $x$select t.id, t.code, t.name, v_year, b.entitled_days, coalesce(b.used_days, 0),$x$,
  $x$select t.id, t.code, t.name, v_year, coalesce(b.entitled_days, t.annual_days),
           coalesce(b.used_days, 0),$x$);

select core.patch_function('hr.execute(text, uuid)',
  $x$    if (select annual_days from hr.leave_type where id = v_l.leave_type_id) is not null then
      update hr.leave_balance set used_days = used_days + v_l.days$x$,
  $x$    if (select annual_days from hr.leave_type where id = v_l.leave_type_id) is not null then
      -- no balance for this year yet: it starts as the type's full year (ADR 167)
      insert into hr.leave_balance (tenant_id, worker_id, owner_user_id, org_node_id,
                                    leave_type_id, year, entitled_days)
      select v_l.tenant_id, w.id, w.owner_user_id, w.org_node_id, t.id, v_year, t.annual_days
        from hr.worker w, hr.leave_type t
       where w.id = v_l.worker_id and t.id = v_l.leave_type_id
      on conflict (worker_id, leave_type_id, year) do nothing;
      update hr.leave_balance set used_days = used_days + v_l.days$x$);

create or replace function rpt.leave_rows(p_workers uuid[], p_year integer)
returns table (worker_id uuid, leave_type_id uuid, remaining numeric, day_rate numeric)
language sql stable
set search_path = pg_catalog, hr
as $$
  select w.id, t.id,
         greatest(coalesce(b.entitled_days, t.annual_days) - coalesce(b.used_days, 0), 0),
         case s.pay_basis when 'monthly' then s.pay_rate * 12 / 365
                          when 'hourly' then s.pay_rate * 8 end
    from hr.worker w
    join hr.leave_type t on t.tenant_id = w.tenant_id and t.annual_days is not null
    left join hr.leave_balance b on b.worker_id = w.id and b.leave_type_id = t.id
                                and b.year = p_year
    left join hr.worker_sensitive s on s.worker_id = w.id
   where w.id = any (p_workers) and w.status = 'active'
     and (b.id is not null or t.archived_at is null)
$$;

-- migrate:down
create or replace function rpt.leave_rows(p_workers uuid[], p_year integer)
returns table (worker_id uuid, leave_type_id uuid, remaining numeric, day_rate numeric)
language sql stable
set search_path = pg_catalog, hr
as $$
  select b.worker_id, b.leave_type_id, greatest(b.entitled_days - b.used_days, 0),
         case s.pay_basis when 'monthly' then s.pay_rate * 12 / 365
                          when 'hourly' then s.pay_rate * 8 end
    from hr.leave_balance b
    join hr.worker w on w.id = b.worker_id and w.status = 'active'
    join hr.leave_type t on t.id = b.leave_type_id and t.annual_days is not null
    left join hr.worker_sensitive s on s.worker_id = b.worker_id
   where b.worker_id = any (p_workers) and b.year = p_year
$$;
select core.patch_function('hr.execute(text, uuid)',
  $x$    if (select annual_days from hr.leave_type where id = v_l.leave_type_id) is not null then
      -- no balance for this year yet: it starts as the type's full year (ADR 167)
      insert into hr.leave_balance (tenant_id, worker_id, owner_user_id, org_node_id,
                                    leave_type_id, year, entitled_days)
      select v_l.tenant_id, w.id, w.owner_user_id, w.org_node_id, t.id, v_year, t.annual_days
        from hr.worker w, hr.leave_type t
       where w.id = v_l.worker_id and t.id = v_l.leave_type_id
      on conflict (worker_id, leave_type_id, year) do nothing;
      update hr.leave_balance set used_days = used_days + v_l.days$x$,
  $x$    if (select annual_days from hr.leave_type where id = v_l.leave_type_id) is not null then
      update hr.leave_balance set used_days = used_days + v_l.days$x$);
select core.patch_function('hr.leave_balances(uuid, integer)',
  $x$select t.id, t.code, t.name, v_year, coalesce(b.entitled_days, t.annual_days),
           coalesce(b.used_days, 0),$x$,
  $x$select t.id, t.code, t.name, v_year, b.entitled_days, coalesce(b.used_days, 0),$x$);
select core.patch_function('hr.leave_available(uuid, uuid, integer, uuid)',
  $x$               where b.worker_id = p_worker and b.leave_type_id = p_type and b.year = p_year),
             t.annual_days)$x$,
  $x$               where b.worker_id = p_worker and b.leave_type_id = p_type and b.year = p_year), 0)$x$);
