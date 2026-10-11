-- migrate:up
-- Start again (ADR 130): a platform admin empties a TEST customer, every row it has in every
-- schema, keeping only the customer itself (its name, plan and settings) and the team
-- console's own records (jobs, files, audit). Then its current files are imported as for a new
-- customer, and Logins links everyone's existing sign-in again by username. Refused for a
-- real customer and unless the customer's name is typed to confirm. The one exception to "no
-- hard deletes": a test customer's data is ours, made up for demos.

create function platform.reset_test_customer(p_tenant uuid, p_confirm text) returns int
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_admin uuid := platform.current_admin();
  v_t core.tenant;
  v_tables text[];
  v_t2 text;
  v_left text[];
  v_done int := 0;
  v_round int := 0;
  v_n int;
  v_progress boolean;
begin
  select * into v_t from core.tenant where id = p_tenant for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'no such customer';
  end if;
  if not v_t.is_test then
    raise exception 'REAL_CUSTOMER' using detail = 'only a test customer can start again';
  end if;
  if p_confirm is distinct from v_t.name then
    raise exception 'CONFIRM_NAME' using detail = 'type the customer''s name to confirm';
  end if;

  -- every table holding the customer's rows, outside the team console's own
  select array_agg(format('%I.%I', n.nspname, c.relname) order by n.nspname, c.relname)
    into v_tables
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and not c.relispartition
     and n.nspname not in ('pg_catalog', 'information_schema', 'platform', 'public', 'extensions')
     and not (n.nspname = 'core' and c.relname = 'tenant')
     and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped);

  -- the audit trail, the append-only guards and the ledger's no-delete rule stand aside for
  -- this transaction only (the tables stay locked until it ends)
  foreach v_t2 in array v_tables loop
    execute format('alter table %s disable trigger user', v_t2);
  end loop;

  -- delete table by table; one that others still point at waits for the next round
  v_left := v_tables;
  while cardinality(v_left) > 0 loop
    v_round := v_round + 1;
    v_progress := false;
    foreach v_t2 in array v_left loop
      begin
        execute format('delete from %s where tenant_id = $1', v_t2) using p_tenant;
        get diagnostics v_n = row_count;
        v_done := v_done + v_n;
        v_left := array_remove(v_left, v_t2);
        v_progress := true;
      exception when foreign_key_violation then
        null;
      end;
    end loop;
    if not v_progress then
      raise exception 'RESET_STUCK' using detail = array_to_string(v_left, ', ');
    end if;
  end loop;

  foreach v_t2 in array v_tables loop
    execute format('alter table %s enable trigger user', v_t2);
  end loop;

  perform platform.log('customer_reset', p_tenant, 'start again',
                       jsonb_build_object('rows', v_done, 'admin', v_admin));
  return v_done;
end $$;

revoke execute on function platform.reset_test_customer(uuid, text) from public;
grant execute on function platform.reset_test_customer(uuid, text) to app_rw;

-- migrate:down
drop function platform.reset_test_customer(uuid, text);
