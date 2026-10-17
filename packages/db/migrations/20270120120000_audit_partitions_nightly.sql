-- migrate:up
-- The audit log's monthly partitions are made every night (ADR 167, review M45).
--
-- audit.ensure_partitions(2) ran once, at migration, so months after the third went to
-- audit.log_default; and a month with rows in the default partition cannot get its own
-- partition ("updated partition constraint for default partition would be violated").
-- audit.keep_partitions makes the partitions from this month to p_months_ahead months out,
-- plus one for every month that has rows in the default partition, moving those rows into it
-- first. It is SECURITY DEFINER (owned by migrator, the tables' owner) so the nightly job may
-- run it as wf_executor; it takes no input that names a table.

create function audit.keep_partitions(p_months_ahead int default 3) returns int
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_start date;
  v_name text;
  v_made int := 0;
begin
  for v_start in
    select (date_trunc('month', now() at time zone 'utc') + make_interval(months => i))::date
      from generate_series(0, least(greatest(coalesce(p_months_ahead, 3), 0), 24)) i
    union
    select distinct date_trunc('month', d.occurred_at at time zone 'utc')::date
      from audit.log_default d
    order by 1
  loop
    v_name := format('log_y%sm%s', to_char(v_start, 'YYYY'), to_char(v_start, 'MM'));
    continue when to_regclass('audit.' || v_name) is not null;
    -- the month's rows wait in a temporary table while its partition is made
    create temporary table if not exists audit_keep_moving (like audit.log) on commit drop;
    truncate audit_keep_moving;
    with moved as (
      delete from audit.log_default
       where occurred_at >= (v_start::timestamp at time zone 'utc')
         and occurred_at < ((v_start + interval '1 month')::timestamp at time zone 'utc')
      returning *)
    insert into audit_keep_moving select * from moved;
    execute format(
      'create table audit.%I partition of audit.log for values from (%L) to (%L)',
      v_name, (v_start::timestamp at time zone 'utc'),
      ((v_start + interval '1 month')::timestamp at time zone 'utc'));
    insert into audit.log select * from audit_keep_moving;
    v_made := v_made + 1;
  end loop;
  return v_made;
end $$;
revoke execute on function audit.keep_partitions(int) from public;
grant execute on function audit.keep_partitions(int) to wf_executor;

select audit.keep_partitions(3);

-- migrate:down
revoke execute on function audit.keep_partitions(int) from wf_executor;
drop function audit.keep_partitions(int);
