-- migrate:up
-- A frontline person asks their department head for stock (ADR 115). The head gives it from
-- the department's store, asks for it (inv.ask_for_stock: the chain), or says no. Whatever
-- arrives for an ask comes back to the head to give. Whoever asked follows it the whole way.

create table inv.staff_ask (
  id uuid primary key default core.uuid_v7(),
  tenant_id uuid not null references core.tenant (id),
  delivery_node_id uuid not null references core.hierarchy_node (id),  -- the store
  org_node_id uuid not null references core.hierarchy_node (id),       -- its department
  asked_by uuid not null references core.app_user (id),
  status text not null default 'asked'
    check (status in ('asked', 'asked_on', 'given', 'closed')),
  note text check (length(note) <= 500),
  given_by uuid references core.app_user (id),
  given_at timestamptz,
  closed_reason text check (length(closed_reason) <= 500),
  closed_by uuid references core.app_user (id),
  closed_at timestamptz,
  idempotency_key text,
  created_at timestamptz not null default now(),
  created_by uuid default core.current_user_id(),
  updated_at timestamptz not null default now(),
  updated_by uuid default core.current_user_id()
);
create unique index staff_ask_idem on inv.staff_ask (tenant_id, created_by, idempotency_key)
  where idempotency_key is not null;
create index staff_ask_asker on inv.staff_ask (asked_by, created_at desc);

create table inv.staff_ask_line (
  id uuid primary key default core.uuid_v7(),
  tenant_id uuid not null references core.tenant (id),
  ask_id uuid not null references inv.staff_ask (id),
  delivery_node_id uuid not null references core.hierarchy_node (id),
  item_id uuid not null references inv.item (id),
  qty numeric(14, 3) not null check (qty > 0),
  created_at timestamptz not null default now(),
  created_by uuid default core.current_user_id(),
  updated_at timestamptz not null default now(),
  updated_by uuid default core.current_user_id(),
  unique (ask_id, item_id)
);

alter table inv.transfer add column for_ask_id uuid references inv.staff_ask (id);
create index transfer_for_ask on inv.transfer (for_ask_id) where for_ask_id is not null;
alter table ops.task add column staff_ask_id uuid references inv.staff_ask (id);
create index task_staff_ask on ops.task (staff_ask_id) where staff_ask_id is not null;
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind in (
  'one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill',
  'minibar_bill', 'sign_off', 'handover', 'discard', 'send', 'ask'));
alter table ops.task add constraint task_ask check ((kind = 'ask') = (staff_ask_id is not null));

create trigger touch before update on inv.staff_ask for each row execute function core.touch();
create trigger touch before update on inv.staff_ask_line for each row execute function core.touch();

-- RLS (rule 1), audit (rule 5): read and written through the functions below only
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('inv.staff_ask', 'TRANSFERS', 'delivery', true),
  ('inv.staff_ask_line', 'TRANSFERS', 'delivery', true);
select core.apply_domain_rls('inv.staff_ask');
select core.apply_domain_rls('inv.staff_ask_line');
select audit.enable('inv.staff_ask');
select audit.enable('inv.staff_ask_line');

-- The stores whose team the caller works in: where they may ask.
create function inv.my_ask_stores() returns table (id uuid, name text)
language sql stable security definer
set search_path = pg_catalog, core, inv, ops, hr
as $$
  select distinct s.id, inv.short_name(s.id)
    from core.hierarchy_node s
    join hr.worker w on w.owner_user_id = core.current_user_id() and w.status = 'active'
                    and w.tenant_id = s.tenant_id
    join core.hierarchy_node h on h.id = w.org_node_id
    join core.hierarchy_node team on team.id = ops.team_of_store(s.id)
   where s.tenant_id = core.my_tenant() and s.type = 'delivery' and s.archived_at is null
     and s.holds_stock and h.path operator(extensions.<@) team.path
   order by 2;
$$;

create function inv.staff_ask_items_text(p_ask uuid) returns text
language sql stable security definer
set search_path = pg_catalog, inv
as $$
  select string_agg(format('%s × %s', trim_scale(l.qty), i.name), ', ' order by i.name)
    from inv.staff_ask_line l join inv.item i on i.id = l.item_id where l.ask_id = p_ask;
$$;

-- The department's heads for an ask: its department head, else the outlet's manager.
create function inv.ask_heads(p_ask uuid) returns uuid[]
language sql stable security definer
set search_path = pg_catalog, ops, inv
as $$
  select ops.leads(a.org_node_id, array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'], array[a.asked_by])
    from inv.staff_ask a where a.id = p_ask;
$$;

create function inv.ask_tell(p_ask uuid, p_people uuid[], p_title text, p_body text default null)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_a inv.staff_ask;
  v_u uuid;
begin
  select * into v_a from inv.staff_ask where id = p_ask;
  for v_u in select distinct u from unnest(p_people) u
              where u is not null and u is distinct from core.current_user_id() loop
    perform ops.notify(v_a.tenant_id, v_u, 'stock_request', left(p_title, 200), p_body,
                       '/stock/asks/' || p_ask);
  end loop;
end $$;

create function inv.raise_staff_ask(p_store uuid, p_lines jsonb, p_note text default null,
                                    p_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_a inv.staff_ask;
  v_team uuid;
  v_heads uuid[];
  v_task ops.task;
begin
  if p_key is not null then
    select * into v_a from inv.staff_ask
     where tenant_id = v_me.tenant_id and created_by = v_me.id and idempotency_key = p_key;
    if found then return v_a.id; end if;
  end if;
  if not exists (select 1 from inv.my_ask_stores() s where s.id = p_store) then
    perform inv.fail('NOT_AUTHORISED', 'ask the store your team uses');
  end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0
     or exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)
                 where l.qty is null or l.qty <= 0) then
    perform inv.fail('INVALID_LINES', 'say what you need and how many');
  end if;
  perform inv.check_lines(p_lines, p_store);
  v_team := ops.team_of_store(p_store);
  insert into inv.staff_ask (tenant_id, delivery_node_id, org_node_id, asked_by, note,
                             idempotency_key)
  values (v_me.tenant_id, p_store, v_team, v_me.id, nullif(btrim(coalesce(p_note, '')), ''), p_key)
  returning * into v_a;
  insert into inv.staff_ask_line (tenant_id, ask_id, delivery_node_id, item_id, qty)
  select v_me.tenant_id, v_a.id, p_store, l.item_id, sum(l.qty)
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric) group by l.item_id;
  v_heads := inv.ask_heads(v_a.id);
  if cardinality(v_heads) = 0 then
    perform inv.fail('NO_APPROVER', 'nobody heads your department');
  end if;
  insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, description,
                        priority, due_at, status, assign_mode, assignee_user_id, assigned_by,
                        staff_ask_id)
  values (v_me.tenant_id, v_team, p_store, 'ask',
          left(v_me.display_name || ' asks for ' || inv.staff_ask_items_text(v_a.id), 200),
          v_a.note, 'normal', now() + interval '2 hours', 'open', 'person', v_heads[1], v_me.id,
          v_a.id)
  returning * into v_task;
  perform inv.ask_tell(v_a.id, v_heads, v_task.title, v_a.note);
  return v_a.id;
end $$;

-- Who may act on an ask: whoever runs the store (TRANSFERS modify there) or heads its team,
-- never whoever asked.
create function inv.require_ask_head(p_ask uuid) returns inv.staff_ask
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_a inv.staff_ask;
begin
  select * into v_a from inv.staff_ask where id = p_ask and tenant_id = core.my_tenant() for update;
  if not found or v_a.asked_by = core.current_user_id()
     or not (core.can('TRANSFERS', 'modify', null, v_a.delivery_node_id)
             or core.current_user_id() = any (inv.ask_heads(p_ask))) then
    perform inv.fail('NOT_AUTHORISED', 'only the department head acts on this');
  end if;
  if v_a.status in ('given', 'closed') then
    perform inv.fail('INVALID_STATE', format('already %s', v_a.status));
  end if;
  return v_a;
end $$;

create function inv.give_staff_ask(p_ask uuid, p_note text default null) returns text
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_a inv.staff_ask := inv.require_ask_head(p_ask);
  v_me uuid := core.current_user_id();
begin
  update inv.staff_ask set status = 'given', given_by = v_me, given_at = now() where id = p_ask;
  update ops.task set status = 'done', completed_by = v_me, completed_at = now()
   where staff_ask_id = p_ask and kind = 'ask' and status in ('open', 'in_progress');
  perform inv.ask_tell(p_ask, array[v_a.asked_by],
                       'Ready for you: ' || inv.staff_ask_items_text(p_ask),
                       coalesce(nullif(btrim(coalesce(p_note, '')), ''),
                                'From ' || (select display_name from core.app_user where id = v_me)));
  return 'given';
end $$;

create function inv.close_staff_ask(p_ask uuid, p_reason text) returns text
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_a inv.staff_ask := inv.require_ask_head(p_ask);
  v_me uuid := core.current_user_id();
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    perform inv.fail('REASON_REQUIRED', 'say why');
  end if;
  update inv.staff_ask set status = 'closed', closed_by = v_me, closed_at = now(),
                           closed_reason = btrim(p_reason)
   where id = p_ask;
  update ops.task set status = 'done', completed_by = v_me, completed_at = now()
   where staff_ask_id = p_ask and kind = 'ask' and status in ('open', 'in_progress');
  perform inv.ask_tell(p_ask, array[v_a.asked_by],
                       'Not given: ' || inv.staff_ask_items_text(p_ask), btrim(p_reason));
  return 'closed';
end $$;

-- The store is short: ask for it (the chain), linked to the ask.
create function inv.ask_for_staff(p_ask uuid) returns uuid[]
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_a inv.staff_ask := inv.require_ask_head(p_ask);
  v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_ids from inv.transfer where for_ask_id = p_ask;
  if cardinality(v_ids) > 0 then
    return v_ids;
  end if;
  v_ids := inv.ask_for_stock(v_a.delivery_node_id,
                             (select jsonb_agg(jsonb_build_object('item_id', item_id, 'qty', qty))
                                from inv.staff_ask_line where ask_id = p_ask),
                             'For ' || (select display_name from core.app_user where id = v_a.asked_by),
                             'ask:' || p_ask);
  update inv.transfer set for_ask_id = p_ask where id = any (v_ids);
  update inv.staff_ask set status = 'asked_on' where id = p_ask;
  perform inv.ask_tell(p_ask, array[v_a.asked_by],
                       'Asked the ' || (select string_agg(distinct inv.short_name(t.from_node_id), ' and the ')
                                          from inv.transfer t where t.id = any (v_ids))
                         || ' for it',
                       inv.staff_ask_items_text(p_ask));
  return v_ids;
end $$;

-- Arrived for an ask: whoever asked hears it; the head gives it.
select core.patch_function('inv.after_receive(uuid)',
  $x$  if v_t.for_transfer_id is not null then$x$,
  $x$  if v_t.for_ask_id is not null then
    perform inv.ask_tell(v_t.for_ask_id, inv.ask_heads(v_t.for_ask_id),
                         'It has arrived: give it to '
                           || (select u.display_name from inv.staff_ask a
                                 join core.app_user u on u.id = a.asked_by
                                where a.id = v_t.for_ask_id),
                         v_items);
    perform inv.ask_tell(v_t.for_ask_id,
                         array[(select asked_by from inv.staff_ask where id = v_t.for_ask_id)],
                         'Arrived at the ' || inv.short_name(v_t.to_node_id), v_items);
  end if;
  if v_t.for_transfer_id is not null then$x$);

-- Whoever asked a request for an ask hears where it is too.
select core.patch_function('inv.askers(uuid)',
  $x$  select array[(select created_by from inv.transfer where id = inv.root_transfer(p_transfer)),
               (select created_by from inv.transfer where id = p_transfer)];$x$,
  $x$  select array[(select created_by from inv.transfer where id = inv.root_transfer(p_transfer)),
               (select created_by from inv.transfer where id = p_transfer),
               (select a.asked_by from inv.transfer t join inv.staff_ask a on a.id = t.for_ask_id
                 where t.id = inv.root_transfer(p_transfer))];$x$);

create function inv.may_follow_ask(p_ask uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select exists (select 1 from inv.staff_ask a
                  where a.id = p_ask and a.tenant_id = core.my_tenant()
                    and (a.asked_by = core.current_user_id()
                         or core.can('TRANSFERS', 'view', null, a.delivery_node_id)
                         or core.current_user_id() = any (inv.ask_heads(p_ask))));
$$;

create function inv.staff_ask_now(p_ask uuid) returns table (stage text, words text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_a inv.staff_ask;
  v_words text;
begin
  perform wf.me();
  if not inv.may_follow_ask(p_ask) then
    perform inv.fail('NOT_AUTHORISED', 'follow this ask');
  end if;
  select * into v_a from inv.staff_ask where id = p_ask;
  if v_a.status = 'given' then
    return query select 'given'::text,
      'Given by ' || (select display_name from core.app_user where id = v_a.given_by);
  elsif v_a.status = 'closed' then
    return query select 'closed'::text, 'Not given: ' || coalesce(v_a.closed_reason, '');
  elsif v_a.status = 'asked_on' then
    select string_agg(case when n.stage = 'received'
                           then 'At the ' || inv.short_name(t.to_node_id) || ': '
                                || (select display_name from core.app_user u
                                     join ops.task k on k.assignee_user_id = u.id
                                    where k.staff_ask_id = p_ask and k.kind = 'ask'
                                    limit 1) || ' will give it to you'
                           else n.words end, '; ')
      into v_words
      from inv.transfer t cross join lateral inv.now_of(t.id) n
     where t.for_ask_id = p_ask;
    return query select 'asked_on'::text, v_words;
  else
    return query select 'with_head'::text,
      'With ' || inv.people_words(array(select assignee_user_id from ops.task
                                         where staff_ask_id = p_ask and kind = 'ask'
                                           and status in ('open', 'in_progress')));
  end if;
end $$;

create function inv.staff_ask_story(p_ask uuid) returns table (at timestamptz, words text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_a inv.staff_ask;
begin
  perform wf.me();
  if not inv.may_follow_ask(p_ask) then
    perform inv.fail('NOT_AUTHORISED', 'follow this ask');
  end if;
  select * into v_a from inv.staff_ask where id = p_ask;
  return query
    select x.at, x.words from (
      select v_a.created_at as at, 0 as rank,
             'Asked by ' || (select display_name from core.app_user where id = v_a.asked_by)
               || ' for ' || inv.staff_ask_items_text(p_ask) as words
      union all
      select s.at, 10 + s.rank, s.words
        from inv.transfer t cross join lateral inv.story_of(t.id, 1) s
       where t.for_ask_id = p_ask
      union all
      select v_a.given_at, 1000,
             'Given by ' || (select display_name from core.app_user where id = v_a.given_by)
       where v_a.given_at is not null
      union all
      select v_a.closed_at, 1000, 'Not given: ' || coalesce(v_a.closed_reason, '')
       where v_a.closed_at is not null) x
    order by x.at, x.rank;
end $$;

-- What the caller asked, newest first, with where each is now.
create function inv.my_staff_asks(p_limit int default 30)
returns table (id uuid, store text, items text, stage text, words text, created_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  perform wf.me();
  return query
    select a.id, inv.short_name(a.delivery_node_id), inv.staff_ask_items_text(a.id),
           n.stage, n.words, a.created_at
      from inv.staff_ask a cross join lateral inv.staff_ask_now(a.id) n
     where a.asked_by = core.current_user_id() and a.tenant_id = core.my_tenant()
     order by a.created_at desc
     limit least(greatest(coalesce(p_limit, 30), 1), 200);
end $$;

revoke execute on function inv.staff_ask_items_text(uuid), inv.ask_heads(uuid),
  inv.ask_tell(uuid, uuid[], text, text), inv.require_ask_head(uuid), inv.may_follow_ask(uuid)
  from public;
revoke execute on function inv.my_ask_stores(), inv.raise_staff_ask(uuid, jsonb, text, text),
  inv.give_staff_ask(uuid, text), inv.close_staff_ask(uuid, text), inv.ask_for_staff(uuid),
  inv.staff_ask_now(uuid), inv.staff_ask_story(uuid), inv.my_staff_asks(int)
  from public;
grant execute on function inv.my_ask_stores(), inv.raise_staff_ask(uuid, jsonb, text, text),
  inv.give_staff_ask(uuid, text), inv.close_staff_ask(uuid, text), inv.ask_for_staff(uuid),
  inv.staff_ask_now(uuid), inv.staff_ask_story(uuid), inv.my_staff_asks(int)
  to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
select core.patch_function('inv.askers(uuid)',
  $x$,
               (select a.asked_by from inv.transfer t join inv.staff_ask a on a.id = t.for_ask_id
                 where t.id = inv.root_transfer(p_transfer))];$x$,
  $x$];$x$);
select core.patch_function('inv.after_receive(uuid)',
  $x$  if v_t.for_ask_id is not null then
    perform inv.ask_tell(v_t.for_ask_id, inv.ask_heads(v_t.for_ask_id),
                         'It has arrived: give it to '
                           || (select u.display_name from inv.staff_ask a
                                 join core.app_user u on u.id = a.asked_by
                                where a.id = v_t.for_ask_id),
                         v_items);
    perform inv.ask_tell(v_t.for_ask_id,
                         array[(select asked_by from inv.staff_ask where id = v_t.for_ask_id)],
                         'Arrived at the ' || inv.short_name(v_t.to_node_id), v_items);
  end if;
$x$, '');
drop function inv.my_staff_asks(int);
drop function inv.staff_ask_story(uuid);
drop function inv.staff_ask_now(uuid);
drop function inv.may_follow_ask(uuid);
drop function inv.ask_for_staff(uuid);
drop function inv.close_staff_ask(uuid, text);
drop function inv.give_staff_ask(uuid, text);
drop function inv.require_ask_head(uuid);
drop function inv.raise_staff_ask(uuid, jsonb, text, text);
drop function inv.ask_tell(uuid, uuid[], text, text);
drop function inv.ask_heads(uuid);
drop function inv.staff_ask_items_text(uuid);
drop function inv.my_ask_stores();
delete from ops.task where kind = 'ask';
alter table ops.task drop constraint task_ask;
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind in (
  'one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill',
  'minibar_bill', 'sign_off', 'handover', 'discard', 'send'));
drop index ops.task_staff_ask;
alter table ops.task drop column staff_ask_id;
drop index inv.transfer_for_ask;
alter table inv.transfer drop column for_ask_id;
delete from core.domain_table where table_name in ('inv.staff_ask'::regclass, 'inv.staff_ask_line'::regclass);
drop table inv.staff_ask_line;
drop table inv.staff_ask;
