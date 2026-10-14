-- migrate:up
-- One request, one screen (ADR 147). A request that began with someone's ask opens on the ask's
-- page, wherever it is opened from (a task, an alert, RFMs, Stock), and that page has every
-- button the viewer may use on any step of it: approve, send, receive, give, take it there.

-- whoever follows any request made for the ask follows the ask (the GM who approves it, the
-- keeper who sends it), as well as whoever asked, the store's people and the heads
create or replace function inv.may_follow_ask(p_ask uuid) returns boolean
language sql stable security definer
set search_path to 'pg_catalog', 'core', 'inv'
as $$
  select exists (select 1 from inv.staff_ask a
                  where a.id = p_ask and a.tenant_id = core.my_tenant()
                    and (a.asked_by = core.current_user_id()
                         or core.can('TRANSFERS', 'view', null, a.delivery_node_id)
                         or core.current_user_id() = any (inv.ask_heads(p_ask))
                         or exists (select 1 from inv.transfer t
                                     where t.for_ask_id = p_ask and inv.may_follow(t.id))));
$$;

-- the requests made for an ask, and those made for them in turn (the chain), oldest first, for
-- whoever follows it
create function inv.ask_requests(p_ask uuid) returns setof uuid
language sql stable security definer
set search_path to 'pg_catalog', 'core', 'inv'
as $$
  with recursive chain as (
    select t.id, t.created_at, 0 as depth from inv.transfer t
     where t.for_ask_id = p_ask and t.tenant_id = core.my_tenant() and inv.may_follow_ask(p_ask)
    union all
    select t.id, t.created_at, chain.depth + 1
      from inv.transfer t join chain on t.for_transfer_id = chain.id
     where chain.depth < 10
  )
  select id from chain order by created_at;
$$;

-- the ask a request belongs to (its own, or that of the request it was made for), when the
-- viewer may follow that ask: the screen it opens on
create function inv.request_ask(p_transfer uuid) returns uuid
language sql stable security definer
set search_path to 'pg_catalog', 'core', 'inv'
as $$
  select r.for_ask_id from inv.transfer r
   where r.id = inv.root_transfer(p_transfer) and r.tenant_id = core.my_tenant()
     and r.for_ask_id is not null and inv.may_follow_ask(r.for_ask_id);
$$;

revoke execute on function inv.ask_requests(uuid), inv.request_ask(uuid) from public;
grant execute on function inv.ask_requests(uuid), inv.request_ask(uuid) to app_rw;

-- migrate:down
drop function inv.request_ask(uuid);
drop function inv.ask_requests(uuid);
create or replace function inv.may_follow_ask(p_ask uuid) returns boolean
language sql stable security definer
set search_path to 'pg_catalog', 'core', 'inv'
as $$
  select exists (select 1 from inv.staff_ask a
                  where a.id = p_ask and a.tenant_id = core.my_tenant()
                    and (a.asked_by = core.current_user_id()
                         or core.can('TRANSFERS', 'view', null, a.delivery_node_id)
                         or core.current_user_id() = any (inv.ask_heads(p_ask))));
$$;
