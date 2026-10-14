-- migrate:up
-- A request the GM must approve first (ADR 115) reads "waiting for approval", not "waiting to
-- be sent", until the GM says yes (ADR 144): the GM's step counts as well as the head's.
create or replace function inv.transfer_awaits_approval(p_request uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, wf
as $$
  select exists (select 1 from wf.step_instance
                  where request_id = p_request and step in ('approval', 'gm_approval')
                    and state = 'pending');
$$;

-- migrate:down
create or replace function inv.transfer_awaits_approval(p_request uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, wf
as $$
  select exists (select 1 from wf.step_instance
                  where request_id = p_request and step = 'approval' and state = 'pending');
$$;
