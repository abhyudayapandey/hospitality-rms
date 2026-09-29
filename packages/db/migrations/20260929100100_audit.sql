-- migrate:up
-- Audit log and generic capture trigger (docs/LLD.md section 8). Append-only:
-- no role has UPDATE or DELETE. Reads go through RLS on the parent table (added in
-- the core_security migration); partitions carry no grants so they cannot be read
-- directly.

create table audit.log (
  id uuid not null default core.uuid_v7(),
  tenant_id uuid,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  actor_kind text not null,
  table_name text not null,
  row_id uuid,
  op text not null,
  before jsonb,
  after jsonb,
  changed_fields text[],
  granting_node_id uuid,
  request_id uuid,
  primary key (id, occurred_at)
) partition by range (occurred_at);

create table audit.log_default partition of audit.log default;
create index log_row on audit.log (table_name, row_id);

-- Creates monthly partitions from the current month to p_months_ahead months out.
-- Schedule monthly (pg_cron / EventBridge) once deployed.
create function audit.ensure_partitions(p_months_ahead int default 2) returns void
language plpgsql as $$
declare
  v_start date;
  v_name text;
begin
  for i in 0..p_months_ahead loop
    v_start := (date_trunc('month', now() at time zone 'utc') + make_interval(months => i))::date;
    v_name := format('log_y%sm%s', to_char(v_start, 'YYYY'), to_char(v_start, 'MM'));
    if to_regclass('audit.' || v_name) is null then
      execute format(
        'create table audit.%I partition of audit.log for values from (%L) to (%L)',
        v_name, v_start::timestamptz, (v_start + interval '1 month')::timestamptz);
    end if;
  end loop;
end $$;
revoke execute on function audit.ensure_partitions(int) from public;
select audit.ensure_partitions(2);

-- Generic audit trigger. Pass 'names_only' for sensitive tables: before/after are
-- dropped and only the changed field names are kept.
create function audit.capture() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changed text[];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  select array_agg(k order by k) into v_changed
    from (select jsonb_object_keys(coalesce(v_new, '{}')) as k
          union
          select jsonb_object_keys(coalesce(v_old, '{}'))) keys
   where (v_old -> k) is distinct from (v_new -> k);

  if tg_nargs > 0 and tg_argv[0] = 'names_only' then
    v_old := null;
    v_new := null;
  end if;

  insert into audit.log (tenant_id, actor_id, actor_kind, table_name, row_id, op,
                         before, after, changed_fields, granting_node_id, request_id)
  values ((v_row ->> 'tenant_id')::uuid,
          core.current_user_id(),
          coalesce(nullif(current_setting('app.actor_kind', true), ''), 'human'),
          tg_table_schema || '.' || tg_table_name,
          (v_row ->> 'id')::uuid,
          tg_op,
          v_old, v_new, v_changed,
          nullif(current_setting('app.granting_node', true), '')::uuid,
          nullif(current_setting('app.wf_request', true), '')::uuid);
  return coalesce(new, old);
end $$;
revoke execute on function audit.capture() from public;

-- Attaches the audit trigger to a table (idempotent).
create function audit.enable(p_table regclass, names_only boolean default false) returns void
language plpgsql as $$
begin
  execute format('drop trigger if exists audit on %s', p_table);
  execute format(
    'create trigger audit after insert or update or delete on %s for each row execute function audit.capture(%s)',
    p_table, case when names_only then quote_literal('names_only') else '' end);
end $$;
revoke execute on function audit.enable(regclass, boolean) from public;

-- Audit every core table.
select audit.enable('core.tenant');
select audit.enable('core.hierarchy_node');
select audit.enable('core.node_link');
select audit.enable('core.app_user');
select audit.enable('core.security_group');
select audit.enable('core.role_assignment');
select audit.enable('core.domain');
select audit.enable('core.domain_table');
select audit.enable('core.domain_policy');
select audit.enable('core.bp_policy');

-- migrate:down
drop function audit.enable(regclass, boolean);
do $$
declare r record;
begin
  for r in select tgrelid::regclass as t from pg_trigger where tgfoid = 'audit.capture'::regproc loop
    execute format('drop trigger audit on %s', r.t);
  end loop;
end $$;
drop function audit.capture();
drop function audit.ensure_partitions(int);
drop table audit.log;
