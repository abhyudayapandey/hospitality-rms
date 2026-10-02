-- migrate:up
-- Modules on or off per company (UX-3b, ADR 026). Kept in core.tenant.settings under
-- "modules" ({"events": false, ...}); a module that isn't listed is on. A switched-off
-- module disappears from the screens and its writes are refused with MODULE_OFF; its data
-- and the access rules are untouched, so turning it back on brings everything back.
-- Prep lists need Production: they are off whenever Production is.

create function core.module_codes() returns text[]
language sql immutable
as $$
  select array['checklists', 'events', 'leave', 'maintenance', 'menu_sales', 'prep_lists',
               'production', 'swaps'];
$$;

-- Internal: any company's switch (the tasks job, the workflow trigger).
create function core.module_on(p_tenant uuid, p_code text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((select (t.settings -> 'modules' ->> p_code)::boolean
                     from core.tenant t where t.id = p_tenant), true)
         and (p_code <> 'prep_lists' or core.module_on(p_tenant, 'production'));
$$;

-- The signed-in person's company's modules (anyone signed in may read them).
create function core.my_modules() returns table (code text, "on" boolean)
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select c, core.module_on(core.my_tenant(), c)
    from unnest(core.module_codes()) c
   where core.my_tenant() is not null
   order by c;
$$;

create function core.require_module(p_code text) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core
as $$
begin
  if not (p_code = any (core.module_codes())) then
    raise exception 'INVALID_MODULE' using detail = p_code;
  end if;
  if not core.module_on(core.my_tenant(), p_code) then
    raise exception 'MODULE_OFF' using detail = p_code;
  end if;
end $$;

-- Only the Account Owner (COMPANY_SETTINGS modify at the company) turns modules on or off,
-- for their own company. The tenant's audit trigger records the change.
create function core.set_module(p_code text, p_on boolean) returns void
language plpgsql security definer
set search_path = pg_catalog, core
as $$
declare
  v_tenant uuid := core.my_tenant();
begin
  if not (p_code = any (core.module_codes())) or p_on is null then
    raise exception 'INVALID_MODULE' using detail = coalesce(p_code, '');
  end if;
  if v_tenant is null
     or not core.can('COMPANY_SETTINGS', 'modify', core.org_root(v_tenant), null, null) then
    raise exception 'NOT_AUTHORISED' using detail = 'COMPANY_SETTINGS modify at the company';
  end if;
  update core.tenant
     set settings = jsonb_set(settings, '{modules}',
                              coalesce(settings -> 'modules', '{}') || jsonb_build_object(p_code, p_on))
   where id = v_tenant
     and (settings -> 'modules' -> p_code) is distinct from to_jsonb(p_on);
end $$;

-- Leave and swap requests are refused while their module is off, whatever screen or
-- function starts them.
create function wf.module_check() returns trigger
language plpgsql
set search_path = pg_catalog, core, wf
as $$
declare
  v_code text := case new.process_type when 'LEAVE' then 'leave'
                                       when 'SHIFT_SWAP' then 'swaps' end;
begin
  if v_code is not null and not core.module_on(new.tenant_id, v_code) then
    raise exception 'MODULE_OFF' using detail = v_code;
  end if;
  return new;
end $$;
create trigger module_check before insert on wf.request
  for each row execute function wf.module_check();

-- The tasks job makes no checklist rounds for a company with Checklists off.
do $$
declare
  v_src text := pg_get_functiondef('ops.tasks_tick(timestamptz)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_src,
    'where c.archived_at is null and core.tenant_active(c.tenant_id)',
    'where c.archived_at is null and core.tenant_active(c.tenant_id)
       and core.module_on(c.tenant_id, ''checklists'')');
  if v_new = v_src then raise exception 'tasks_tick: anchor not found'; end if;
  execute v_new;
end $$;

revoke execute on function core.module_on(uuid, text), core.my_modules(),
  core.require_module(text), core.set_module(text, boolean) from public;
grant execute on function core.my_modules(), core.require_module(text),
  core.set_module(text, boolean) to app_rw;

-- migrate:down
do $$
declare
  v_src text := pg_get_functiondef('ops.tasks_tick(timestamptz)'::regprocedure);
begin
  execute replace(v_src, '
       and core.module_on(c.tenant_id, ''checklists'')', '');
end $$;
drop trigger module_check on wf.request;
drop function wf.module_check();
drop function core.set_module(text, boolean), core.require_module(text), core.my_modules(),
  core.module_on(uuid, text), core.module_codes();
