-- migrate:up
-- The re-audit's report fixes (ADR 160).
--
-- * People are the people who work: the account owner and a test customer's demo presenter
--   are logins, not staff, so the People report (headcount, its departments, its list, its
--   leave) leaves them out. rpt.place_workers is what every People figure starts from, so they
--   all still add up (reports-reconcile).
-- * Covers ask only for the meals the outlet serves: Breakfast where it has rooms (breakfast is
--   the hotel restaurant's, ADR 068), or where breakfast covers were already given that day.

create or replace function rpt.place_workers(p_place uuid)
returns uuid[]
language sql stable
set search_path = pg_catalog, core, hr, extensions
as $$
  select coalesce(array_agg(w.id), '{}')
    from core.hierarchy_node p
    join core.hierarchy_node h on h.type = 'org' and h.path <@ p.path
    join hr.worker w on w.org_node_id = h.id
    join core.app_user u on u.id = w.owner_user_id
   where p.id = p_place
     and w.role_code is distinct from 'ACCOUNT_OWNER'
     and not u.demo_presenter
$$;

create or replace function ops.covers_day(p_outlet uuid, p_day date)
returns table (period text, covers int, total_covers int, sales numeric, per_cover numeric,
               can_edit boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
#variable_conflict use_column
declare
  v_sales numeric;
  v_total int;
  v_edit boolean;
  v_breakfast boolean;
begin
  if not core.module_on(core.my_tenant(), 'menu_sales')
     or not rpt.can_open('outlet_flash', p_outlet) then
    perform ops.fail('NOT_AUTHORISED', 'the outlet''s sales');
  end if;
  v_edit := ops.can_give_covers(p_outlet);
  select coalesce(sum(s.sales), 0) into v_sales from rpt.sales_of(p_outlet, p_day) s;
  select sum(c.covers)::int into v_total from ops.covers c
   where c.org_node_id = p_outlet and c.day = p_day;
  v_breakfast := exists (select 1 from ops.room r
                          where r.org_node_id = p_outlet and r.archived_at is null)
                 or exists (select 1 from ops.covers c
                             where c.org_node_id = p_outlet and c.day = p_day
                               and c.period = 'breakfast');
  return query
    select m.period, c.covers, v_total, v_sales,
           round(v_sales / nullif(v_total, 0), 2), v_edit
      from (values ('breakfast', 1), ('lunch', 2), ('dinner', 3)) m(period, ord)
      left join ops.covers c on c.org_node_id = p_outlet and c.day = p_day
                            and c.period = m.period
     where m.period <> 'breakfast' or v_breakfast
     order by m.ord;
end $$;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous rules for local work.
create or replace function rpt.place_workers(p_place uuid)
returns uuid[]
language sql stable
set search_path = pg_catalog, core, hr, extensions
as $$
  select coalesce(array_agg(w.id), '{}')
    from core.hierarchy_node p
    join core.hierarchy_node h on h.type = 'org' and h.path <@ p.path
    join hr.worker w on w.org_node_id = h.id
   where p.id = p_place
$$;

create or replace function ops.covers_day(p_outlet uuid, p_day date)
returns table (period text, covers int, total_covers int, sales numeric, per_cover numeric,
               can_edit boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
#variable_conflict use_column
declare
  v_sales numeric;
  v_total int;
  v_edit boolean;
begin
  if not core.module_on(core.my_tenant(), 'menu_sales')
     or not rpt.can_open('outlet_flash', p_outlet) then
    perform ops.fail('NOT_AUTHORISED', 'the outlet''s sales');
  end if;
  v_edit := ops.can_give_covers(p_outlet);
  select coalesce(sum(s.sales), 0) into v_sales from rpt.sales_of(p_outlet, p_day) s;
  select sum(c.covers)::int into v_total from ops.covers c
   where c.org_node_id = p_outlet and c.day = p_day;
  return query
    select m.period, c.covers, v_total, v_sales,
           round(v_sales / nullif(v_total, 0), 2), v_edit
      from (values ('breakfast', 1), ('lunch', 2), ('dinner', 3)) m(period, ord)
      left join ops.covers c on c.org_node_id = p_outlet and c.day = p_day
                            and c.period = m.period
     order by m.ord;
end $$;
