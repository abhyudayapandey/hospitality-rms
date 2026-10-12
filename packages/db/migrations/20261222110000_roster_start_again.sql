-- migrate:up
-- Start the roster again (ADR 132): discard every draft not yet started, in the week on screen
-- and in the template window (tomorrow to day 7). Anyone on them is freed; published shifts
-- and drafts already under way stay. Staff never saw a draft, so no one is told.
create function hr.discard_drafts(p_node uuid, p_monday date) returns int
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_ids uuid[];
begin
  perform hr.require('ROSTER', 'modify', p_node);
  with c as (
    update hr.shift s set status = 'cancelled'
      from hr.template_window(p_node) w
     where s.org_node_id = p_node and s.status = 'draft' and s.start_at > now()
       and (s.local_date between w.from_day and w.to_day
            or s.local_date between p_monday and p_monday + 6)
    returning s.id)
  select coalesce(array_agg(id), '{}') into v_ids from c;
  update hr.shift_assignment set status = 'dropped', drop_reason = 'shift_cancelled'
   where shift_id = any (v_ids) and status = 'assigned';
  return cardinality(v_ids);
end $$;

revoke execute on function hr.discard_drafts(uuid, date) from public;
grant execute on function hr.discard_drafts(uuid, date) to app_rw;

-- migrate:down
drop function hr.discard_drafts(uuid, date);
