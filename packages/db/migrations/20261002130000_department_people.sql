-- migrate:up
-- People at department level (ADR 009 part 2, Prompt 7 item 7).
--
-- Rosters, shift templates and publishing already work at any org node where the user holds
-- ROSTER modify: a department head builds their department's roster, and where a
-- department has no head, the outlet manager (whose grant covers the outlet's departments)
-- does. This migration adds:
--   * hr.roster_owner: who runs a place's roster, the department head first, falling back
--     up the tree (outlet manager, area manager, account owner), leaving someone out
--   * attendance exceptions assigned to that person, and a queue for a place and every
--     department below it, grouped by department, showing whom each one waits for; the
--     assignee may resolve it (and see it) even when the fallback put it with someone who
--     holds no ATTENDANCE rights there
--   * the leave roster-gap notice goes to the roster owner, not always the outlet manager
--   * a shift may take a worker whose home is the shift's place or any place below it
--     (an outlet-level shift for a department's worker)

-- Who runs the roster at p_node: nearest holder of the first group in the chain that has
-- one, never anyone in p_exclude. Returns the group code and the node it was found at.
create function hr.roster_owner(p_node uuid, p_exclude uuid[] default '{}',
                                out o_group text, out o_node uuid)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_tenant uuid := (select tenant_id from core.hierarchy_node where id = p_node);
  v_code text;
  v_group uuid;
begin
  foreach v_code in array array['DEPARTMENT_HEAD', 'OUTLET_MANAGER', 'AREA_MANAGER',
                                'ACCOUNT_OWNER'] loop
    select id into v_group from core.security_group where tenant_id = v_tenant and code = v_code;
    continue when v_group is null;
    o_node := core.nearest_group_node(v_group, p_node, p_exclude);
    if o_node is not null then
      o_group := v_code;
      return;
    end if;
  end loop;
end $$;

-- hr.roster_owner and the people it points at.
create function hr.roster_owners(p_node uuid, p_exclude uuid[] default '{}',
                                 out o_group text, out o_ids uuid[])
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_node uuid;
begin
  select r.o_group, r.o_node into o_group, v_node from hr.roster_owner(p_node, p_exclude) r;
  select coalesce(array_agg(h.uid order by h.uid), '{}') into o_ids
    from core.security_group g
    cross join lateral core.group_holders(g.id, v_node) h(uid)
   where g.code = o_group and g.tenant_id = (select tenant_id from core.hierarchy_node
                                              where id = p_node)
     and h.uid <> all (coalesce(p_exclude, '{}'));
end $$;

create function hr.roster_owner_ids(p_node uuid, p_exclude uuid[] default '{}') returns uuid[]
language sql stable
set search_path = pg_catalog, core, hr
as $$ select o_ids from hr.roster_owners(p_node, p_exclude) $$;

-- Exceptions of p_node and every place below it, open or closed ('resolved'/'dismissed'),
-- that the caller may see (ATTENDANCE view, their own, or assigned to them). Each row says
-- which department it belongs to and who it waits for. The owners are looked up once per
-- place, and again only for a row whose worker is one of them.
create function hr.exception_queue(p_node uuid, p_status text default 'open')
returns table (id uuid, place_id uuid, place_name text, worker_name text, owner_user_id uuid,
               local_date date, kind text, phase text, detail jsonb, status text,
               resolution_note text, shift_start timestamptz, shift_end timestamptz,
               assignee_group text, assignee_names text[], assigned_to_me boolean)
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  with e0 as materialized (
    select e.*, n.name as place_name, n.path
      from core.hierarchy_node top
      join core.hierarchy_node n on n.tenant_id = top.tenant_id and top.path @> n.path
      join hr.attendance_exception e on e.org_node_id = n.id
     where top.id = p_node and top.type = 'org' and top.tenant_id = core.my_tenant()
       and (case when p_status = 'open' then e.status = 'open'
                 else e.status in ('resolved', 'dismissed') end)),
  per_place as materialized (
    select x.org_node_id, r.o_group, r.o_ids
      from (select distinct org_node_id from e0) x
      cross join lateral hr.roster_owners(x.org_node_id) r),
  e as materialized (
    select e0.*, o.o_group, o.o_ids
      from e0 join per_place p on p.org_node_id = e0.org_node_id
      cross join lateral (
        select r.o_group, r.o_ids from hr.roster_owners(e0.org_node_id, array[e0.owner_user_id]) r
         where e0.owner_user_id = any (p.o_ids)
        union all
        select p.o_group, p.o_ids where not (e0.owner_user_id = any (p.o_ids))) o)
  select e.id, e.org_node_id, e.place_name, coalesce(u.display_name, 'Worker'), e.owner_user_id,
         e.local_date, e.kind, e.phase, e.detail, e.status, e.resolution_note, s.start_at,
         s.end_at, e.o_group,
         (select array_agg(a.display_name order by a.display_name) from core.app_user a
           where a.id = any (e.o_ids)),
         core.current_user_id() = any (e.o_ids)
    from e
    left join core.app_user u on u.id = e.owner_user_id
    left join hr.shift s on s.id = e.shift_id
   where core.current_user_id() = any (e.o_ids)
      or core.can('ATTENDANCE', 'view', e.org_node_id, null, e.owner_user_id)
   order by e.path, e.local_date desc, 4
   limit 200;
$$;

-- Notifies whoever runs the roster at p_node (never p_about, whom it is about).
create function hr.notify_roster_owner(p_node uuid, p_about uuid, p_kind text, p_title text,
                                       p_body text default null, p_link text default null)
returns void
language sql
set search_path = pg_catalog, core, hr, ops
as $$
  select ops.notify(n.tenant_id, o.uid, p_kind, p_title, p_body, p_link)
    from core.hierarchy_node n
    cross join lateral unnest(hr.roster_owner_ids(p_node, array[p_about])) o(uid)
   where n.id = p_node;
$$;

-- A worker at p_home can work a shift at p_node: the same place or one below it.
create function hr.works_under(p_home uuid, p_node uuid) returns boolean
language sql stable
set search_path = pg_catalog, core, extensions
as $$
  select exists (select 1 from core.hierarchy_node h join core.hierarchy_node s on s.id = p_node
                  where h.id = p_home and s.path @> h.path);
$$;

revoke execute on function hr.roster_owner(uuid, uuid[]), hr.roster_owners(uuid, uuid[]),
  hr.roster_owner_ids(uuid, uuid[]),
  hr.exception_queue(uuid, text), hr.notify_roster_owner(uuid, uuid, text, text, text, text),
  hr.works_under(uuid, uuid) from public;
grant execute on function hr.exception_queue(uuid, text) to app_rw;

do $$
declare
  v_src text;
  v_old text;
begin
  -- the assignee may resolve, besides anyone with ATTENDANCE modify there
  v_src := pg_get_functiondef('hr.resolve_exception(uuid, text, text)'::regprocedure);
  v_old := 'perform hr.require(''ATTENDANCE'', ''modify'', v_e.org_node_id);';
  if position(v_old in v_src) = 0 then
    raise exception 'hr.resolve_exception changed; update this migration';
  end if;
  execute replace(v_src, v_old,
    'if not core.current_user_id() = any (hr.roster_owner_ids(v_e.org_node_id, array[v_e.owner_user_id])) then
    perform hr.require(''ATTENDANCE'', ''modify'', v_e.org_node_id);
  end if;');

  -- the roster gap after approved leave goes to the roster owner
  v_src := pg_get_functiondef('hr.execute(text, uuid)'::regprocedure);
  v_old := 'perform hr.notify_group(v_l.org_node_id, ''OUTLET_MANAGER'', ''roster_gap'',';
  if position(v_old in v_src) = 0 then
    raise exception 'hr.execute changed; update this migration';
  end if;
  execute replace(v_src, v_old,
    'perform hr.notify_roster_owner(v_l.org_node_id, v_l.owner_user_id, ''roster_gap'',');

  -- a worker whose home is the shift's place or below it
  v_src := pg_get_functiondef('hr.assignment_violation(uuid, timestamptz, timestamptz, uuid, text, uuid)'::regprocedure);
  v_old := 'if v_w.org_node_id <> p_node then';
  if position(v_old in v_src) = 0 then
    raise exception 'hr.assignment_violation changed; update this migration';
  end if;
  execute replace(v_src, v_old, 'if not hr.works_under(v_w.org_node_id, p_node) then');
  v_src := pg_get_functiondef('hr.assign_candidates(uuid)'::regprocedure);
  v_old := 'where w.org_node_id = v_shift.org_node_id and';
  if position(v_old in v_src) = 0 then
    raise exception 'hr.assign_candidates changed; update this migration';
  end if;
  execute replace(v_src, v_old, 'where hr.works_under(w.org_node_id, v_shift.org_node_id) and');
end $$;

-- migrate:down
do $$
begin
  execute replace(pg_get_functiondef('hr.assign_candidates(uuid)'::regprocedure),
    'where hr.works_under(w.org_node_id, v_shift.org_node_id) and',
    'where w.org_node_id = v_shift.org_node_id and');
  execute replace(pg_get_functiondef('hr.assignment_violation(uuid, timestamptz, timestamptz, uuid, text, uuid)'::regprocedure),
    'if not hr.works_under(v_w.org_node_id, p_node) then', 'if v_w.org_node_id <> p_node then');
  execute replace(pg_get_functiondef('hr.execute(text, uuid)'::regprocedure),
    'perform hr.notify_roster_owner(v_l.org_node_id, v_l.owner_user_id, ''roster_gap'',',
    'perform hr.notify_group(v_l.org_node_id, ''OUTLET_MANAGER'', ''roster_gap'',');
  execute replace(pg_get_functiondef('hr.resolve_exception(uuid, text, text)'::regprocedure),
    'if not core.current_user_id() = any (hr.roster_owner_ids(v_e.org_node_id, array[v_e.owner_user_id])) then
    perform hr.require(''ATTENDANCE'', ''modify'', v_e.org_node_id);
  end if;', 'perform hr.require(''ATTENDANCE'', ''modify'', v_e.org_node_id);');
end $$;
drop function hr.exception_queue(uuid, text);
drop function hr.notify_roster_owner(uuid, uuid, text, text, text, text);
drop function hr.roster_owner_ids(uuid, uuid[]);
drop function hr.roster_owners(uuid, uuid[]);
drop function hr.roster_owner(uuid, uuid[]);
drop function hr.works_under(uuid, uuid);
