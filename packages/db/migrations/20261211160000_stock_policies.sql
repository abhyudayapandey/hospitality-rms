-- migrate:up
-- Stock policies (ADR 092), chosen at onboarding:
--
-- * Par by day of the week (file 11 `par_by_day`, e.g. "Mon-Thu 10; Fri-Sun 20"): the tasks
--   job sets each store's par to today's (the store's business day, ADR 057), so every "fill to
--   par", running-low list and request uses it. Days not listed keep the file's par.
-- * Purchase approval (file 00 `purchase_approval`): `unusual` (the default, PO-5: off the menu
--   or more than usual), `every` (every order) or `above:<amount>` (an order worth more than the
--   amount at standard cost). Through the same approval chain: the department head, the GM too.
-- * Discard approval (file 10 `discard_approval` = gm): such an item is never thrown away and
--   recorded in one go. Whoever finds it asks (a `discard` task, reported); the GM's one tap
--   gives it to someone in the department (the usual task rules); the stock leaves as wastage
--   when they have thrown it away. An expired batch of such an item is given out by the GM too.
--   Every other discard is recorded as before and its department head is told.

-- ---------------------------------------------------------------------------
-- Par by day
-- ---------------------------------------------------------------------------
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind in (
  'one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill',
  'minibar_bill', 'sign_off', 'handover', 'discard'));

alter table inv.item_node
  add column par_base numeric(14,3),
  add column par_by_day jsonb check (par_by_day is null or jsonb_typeof(par_by_day) = 'object');

-- The par on a day: that weekday's ("1" Monday to "7" Sunday), else the base.
create function inv.par_on(p_by_day jsonb, p_base numeric, p_day date) returns numeric
language sql immutable
as $$
  select coalesce((p_by_day ->> extract(isodow from p_day)::int::text)::numeric, p_base);
$$;

-- Today's par wherever it goes by the day; returns how many changed.
create function inv.apply_par_by_day(p_now timestamptz default now()) returns int
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_n int;
begin
  update inv.item_node n
     set par_level = inv.par_on(n.par_by_day, n.par_base,
                                rpt.business_date(p_now, ops.tz_of(n.delivery_node_id)))
   where n.par_by_day is not null and n.archived_at is null
     and n.par_level is distinct from inv.par_on(n.par_by_day, n.par_base,
                                rpt.business_date(p_now, ops.tz_of(n.delivery_node_id)));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

select core.patch_function('ops.tasks_tick(timestamptz)',
$x$begin
  for v_tpl in$x$,
$x$begin
  -- today's par where it goes by the day (ADR 092)
  perform inv.apply_par_by_day(p_now);
  for v_tpl in$x$);

-- ---------------------------------------------------------------------------
-- Purchase approval
-- ---------------------------------------------------------------------------
-- Whether an order needs approving, by the customer's rule.
create function inv.order_unusual(p_node uuid, p_lines jsonb) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_rule text := coalesce(core.settings_of((select tenant_id from core.hierarchy_node
                                             where id = p_node)) ->> 'purchase_approval',
                          'unusual');
begin
  if v_rule = 'every' then
    return true;
  elsif v_rule like 'above:%' then
    return inv.order_value(p_lines) > substr(v_rule, 7)::numeric;
  end if;
  return exists (select 1 from inv.unusual_calc(p_node, p_lines));
end $$;

-- An order's worth at standard cost.
create function inv.order_value(p_lines jsonb) returns numeric
language sql stable security definer
set search_path = pg_catalog, inv
as $$
  select coalesce(sum(l.qty * coalesce(i.standard_unit_cost, 0)), 0)
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)
    join inv.item i on i.id = l.item_id;
$$;

-- Why it needs approving, in words.
create function inv.order_why(p_node uuid, p_lines jsonb) returns text
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_rule text := coalesce(core.settings_of((select tenant_id from core.hierarchy_node
                                             where id = p_node)) ->> 'purchase_approval',
                          'unusual');
begin
  if v_rule = 'every' then
    return 'Every order is approved here';
  elsif v_rule like 'above:%' then
    return format('Worth ₹%s, above ₹%s', to_char(inv.order_value(p_lines), 'FM9999999990'),
                  substr(v_rule, 7));
  end if;
  return inv.unusual_why(p_node, p_lines);
end $$;

select core.patch_function('inv.create_po(uuid, uuid, jsonb, text, text)',
$x$                         jsonb_build_object('unusual',
                           exists (select 1 from inv.unusual_calc(p_node, p_lines)),
                           'why', inv.unusual_why(p_node, p_lines)));$x$,
$x$                         jsonb_build_object('unusual', inv.order_unusual(p_node, p_lines),
                           'why', inv.order_why(p_node, p_lines)));$x$);

select core.patch_function('inv.request_supplies(uuid, jsonb, text, text)',
$x$                         jsonb_build_object('unusual',
                           exists (select 1 from inv.unusual_calc(p_node, p_lines)),
                           'why', inv.unusual_why(p_node, p_lines)));$x$,
$x$                         jsonb_build_object('unusual', inv.order_unusual(p_node, p_lines),
                           'why', inv.order_why(p_node, p_lines)));$x$);

-- ---------------------------------------------------------------------------
-- Discard approval
-- ---------------------------------------------------------------------------
alter table inv.item add column discard_approval boolean not null default false;
alter table ops.task add column discard_reason text
  check (discard_reason is null or discard_reason in ('expired', 'spoiled', 'prep_error',
                                                      'damaged', 'other'));
alter table ops.task add constraint task_discard
  check (kind <> 'discard' or (delivery_node_id is not null and item_id is not null
                               and target_qty > 0 and discard_reason is not null));

-- Whether someone runs the outlet a store belongs to (an outlet manager there: the GM).
create function inv.is_gm(p_user uuid, p_store uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select p_user = any (ops.leads(coalesce(ops.team_of_store(p_store), p_store),
                                 array['OUTLET_MANAGER']));
$$;

-- Ask for something to be thrown away: a reported `discard` task at the department that uses
-- the store, for its head (or, for an item that needs the GM, the GM) to approve.
create function ops.ask_discard(p_store uuid, p_item uuid, p_qty numeric, p_reason text,
                                p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, inv
as $$
declare
  v_me core.app_user := wf.me();
  v_item inv.item;
  v_team uuid := ops.team_of_store(p_store);
  v_t ops.task;
begin
  if p_idempotency_key is not null then
    select * into v_t from ops.task
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_t.id; end if;
  end if;
  if not exists (select 1 from core.hierarchy_node
                  where id = p_store and tenant_id = v_me.tenant_id and type = 'delivery')
     or not (core.can('STOCK_ADJUSTMENTS', 'modify', null, p_store)
             or inv.can_produce_at(p_store)) then
    perform ops.fail('NOT_AUTHORISED', format('modify STOCK_ADJUSTMENTS at %s', p_store));
  end if;
  select * into v_item from inv.item where id = p_item and tenant_id = v_me.tenant_id;
  if v_item.id is null then
    perform ops.fail('NOT_FOUND', 'no such item');
  end if;
  if v_team is null then
    perform ops.fail('NOT_FOUND', 'no department uses this store');
  end if;
  if p_qty is null or p_qty <= 0 or p_qty > inv.on_hand(p_item, p_store) then
    perform ops.fail('INVALID_QUANTITY', 'more than nothing, no more than the store has');
  end if;
  if coalesce(p_reason, '') not in ('expired', 'spoiled', 'prep_error', 'damaged', 'other') then
    perform ops.fail('INVALID_LINES', 'unknown wastage reason');
  end if;
  insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, description,
                        priority, due_at, status, item_id, target_qty, discard_reason,
                        reported_by, idempotency_key)
  values (v_me.tenant_id, v_team, p_store, 'discard',
          format('Throw away %s %s %s', trim_scale(p_qty), v_item.base_uom, v_item.name),
          format('%s. Asked by %s.', initcap(replace(p_reason, '_', ' ')), v_me.display_name),
          'high', now() + interval '1 hour', 'reported', p_item, p_qty, p_reason, v_me.id,
          p_idempotency_key)
  returning * into v_t;
  perform ops.notify_task(
    v_t,
    case when v_item.discard_approval
         then ops.leads(v_team, array['OUTLET_MANAGER'], array[v_me.id])
         else ops.leads(v_team, p_exclude => array[v_me.id]) end,
    'discard_asked', 'Approve: ' || v_t.title,
    'Asked by ' || v_me.display_name || '. Approving gives it to someone to throw away.');
  return v_t.id;
end $$;

-- Approve it: one tap gives it to whoever is on shift in the department (or a person there).
-- An item that needs the GM: only the GM approves it. Whoever asked never approves it.
create function ops.approve_discard(p_task uuid, p_user uuid default null) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, inv, hr
as $$
declare
  v_t ops.task;
  v_gm boolean;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind = 'discard' for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such request');
  end if;
  if v_t.status <> 'reported' then
    perform ops.fail('INVALID_STATE', 'already approved');
  end if;
  if v_t.reported_by = core.current_user_id() then
    perform ops.fail('SELF_APPROVAL', 'someone else approves what you asked for');
  end if;
  v_gm := (select i.discard_approval from inv.item i where i.id = v_t.item_id);
  if v_gm then
    if not inv.is_gm(core.current_user_id(), v_t.delivery_node_id) then
      perform ops.fail('NEEDS_GM', 'the GM approves throwing this away');
    end if;
  else
    perform hr.require('TASKS', 'modify', v_t.org_node_id);
  end if;
  if p_user is not null and not ops.works_under(p_user, v_t.org_node_id) then
    perform ops.fail('INVALID_ASSIGNEE', 'they do not work at this place');
  end if;
  update ops.task
     set status = 'open', assign_mode = case when p_user is null then 'on_shift' else 'person' end,
         assignee_user_id = p_user, assigned_by = core.current_user_id(),
         due_at = now() + interval '1 hour'
   where id = v_t.id returning * into v_t;
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind, value_num, unit)
  select v_t.tenant_id, v_t.id, v_t.org_node_id, 1, 'Throw it away and record the wastage',
         'discard', v_t.target_qty, i.base_uom from inv.item i where i.id = v_t.item_id;
  perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'task_assigned',
                          'New task: ' || v_t.title);
end $$;

-- the approved discard is thrown away like an expired batch: up to what was approved and the
-- store still has, as wastage, with no second approval
select core.patch_function('ops.discard_expired(uuid, numeric, text)',
$x$  if found and v_t.kind <> 'expiry' then$x$,
$x$  if found and v_t.kind not in ('expiry', 'discard') then$x$);
select core.patch_function('ops.discard_expired(uuid, numeric, text)',
$x$  v_left := (select b.remaining from inv.batch_rows(v_t.item_id, v_t.delivery_node_id) b
              where b.batch_no = v_t.batch_no limit 1);$x$,
$x$  v_left := case when v_t.kind = 'discard'
                 then least(v_t.target_qty, inv.on_hand(v_t.item_id, v_t.delivery_node_id))
                 else (select b.remaining from inv.batch_rows(v_t.item_id, v_t.delivery_node_id) b
                        where b.batch_no = v_t.batch_no limit 1) end;$x$);
select core.patch_function('ops.discard_expired(uuid, numeric, text)',
$x$                             'item_id', v_t.item_id, 'qty', p_qty, 'reason', 'expired',$x$,
$x$                             'item_id', v_t.item_id, 'qty', p_qty,
                             'reason', coalesce(v_t.discard_reason, 'expired'),$x$);

-- an item that needs the GM is never recorded straight away; an approved discard is posted
-- without a second approval
select core.patch_function('inv.post_wastage(uuid, jsonb, text, uuid, uuid)',
$x$    v_cost := inv.avg_cost(v_line.item_id, p_node);
    v_value := round(v_line.qty * v_cost, 2);

    if v_value > v_threshold then$x$,
$x$    if (select i.discard_approval from inv.item i where i.id = v_line.item_id)
       and not exists (select 1 from ops.task t
                        where t.id = p_task and t.kind in ('discard', 'expiry')
                          and inv.is_gm(t.assigned_by, p_node)) then
      perform inv.fail('NEEDS_GM', 'ask for it to be thrown away: the GM approves it');
    end if;
    v_cost := inv.avg_cost(v_line.item_id, p_node);
    v_value := round(v_line.qty * v_cost, 2);

    if v_value > v_threshold
       and not exists (select 1 from ops.task t where t.id = p_task and t.kind = 'discard') then$x$);
select core.patch_function('inv.post_wastage(uuid, jsonb, text, uuid, uuid)',
$x$            case when v_value > v_threshold then 'approval' else 'posted' end, p_task);$x$,
$x$            case when v_value > v_threshold
                       and not exists (select 1 from ops.task t
                                        where t.id = p_task and t.kind = 'discard')
                 then 'approval' else 'posted' end, p_task);$x$);

-- an expired batch of such an item is given out by the GM
select core.patch_function('ops.assign_expiry(uuid, uuid, timestamptz, boolean)',
$x$  if v_t.status <> 'reported' then$x$,
$x$  if (select i.discard_approval from inv.item i where i.id = v_t.item_id)
     and not inv.is_gm(core.current_user_id(), v_t.delivery_node_id) then
    perform ops.fail('NEEDS_GM', 'the GM approves throwing this away');
  end if;
  if v_t.status <> 'reported' then$x$);

-- every other discard: its department head is told too
select core.patch_function('inv.notify_wastage(uuid, uuid[])',
$x$      and not (h = any (array_remove(coalesce(p_exclude, '{}'), null)));
end$x$,
$x$      and not (h = any (array_remove(coalesce(p_exclude, '{}'), null)));
  perform ops.notify(v_w.tenant_id, h, 'wastage', 'Wastage at ' || v_store, v_body,
                     '/stock/wastage')
     from unnest(ops.leads(ops.team_of_store(v_w.delivery_node_id), array['DEPARTMENT_HEAD'],
                           array_remove(coalesce(p_exclude, '{}'), null))) h
    where ops.team_of_store(v_w.delivery_node_id) is not null
      and not (h = any (coalesce(array(select x from core.site_group_holders(v_group,
                                                       v_w.delivery_node_id) x), '{}')));
end$x$);

-- the request's page: whether the GM approves it, and whether I may
select core.patch_function('ops.task_detail(uuid)',
$x$    'can_work', coalesce(ops.can_work(v_t, v_me), false),$x$,
$x$    'discard', case when v_t.kind = 'discard' then jsonb_build_object(
               'needs_gm', (select i.discard_approval from inv.item i where i.id = v_t.item_id),
               'reason', v_t.discard_reason,
               'can_approve', v_t.status = 'reported' and v_t.reported_by is distinct from v_me
                              and case when (select i.discard_approval from inv.item i
                                              where i.id = v_t.item_id)
                                       then inv.is_gm(v_me, v_t.delivery_node_id)
                                       else core.can('TASKS', 'modify', v_t.org_node_id, null) end)
               end,
    'can_work', coalesce(ops.can_work(v_t, v_me), false),$x$);

revoke execute on function inv.par_on(jsonb, numeric, date), inv.apply_par_by_day(timestamptz),
  inv.order_unusual(uuid, jsonb), inv.order_value(jsonb), inv.order_why(uuid, jsonb),
  inv.is_gm(uuid, uuid), ops.ask_discard(uuid, uuid, numeric, text, text),
  ops.approve_discard(uuid, uuid)
  from public, platform_loader;
grant execute on function ops.ask_discard(uuid, uuid, numeric, text, text),
  ops.approve_discard(uuid, uuid) to app_rw;
grant execute on function inv.par_on(jsonb, numeric, date) to platform_loader;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
do $$
begin
  execute regexp_replace(pg_get_functiondef('ops.task_detail(uuid)'::regprocedure),
    E'    ''discard'', case when.*?(    ''can_work'')', E'\\1', 's');
  execute regexp_replace(pg_get_functiondef('inv.notify_wastage(uuid, uuid[])'::regprocedure),
    E'(      and not \\(h = any \\(array_remove\\(coalesce\\(p_exclude, ''\\{\\}''\\), null\\)\\)\\);\n).*?(end)',
    E'\\1\\2', 's');
  execute regexp_replace(pg_get_functiondef('ops.assign_expiry(uuid, uuid, timestamptz, boolean)'::regprocedure),
    E'  if \\(select i.discard_approval.*?(  if v_t.status <> ''reported'' then)', E'\\1', 's');
  execute regexp_replace(pg_get_functiondef('inv.post_wastage(uuid, jsonb, text, uuid, uuid)'::regprocedure),
    E'    if \\(select i.discard_approval.*?(    v_cost := inv.avg_cost)', E'\\1', 's');
end $$;
select core.patch_function('inv.post_wastage(uuid, jsonb, text, uuid, uuid)',
$x$    if v_value > v_threshold
       and not exists (select 1 from ops.task t where t.id = p_task and t.kind = 'discard') then$x$,
$x$    if v_value > v_threshold then$x$);
select core.patch_function('inv.post_wastage(uuid, jsonb, text, uuid, uuid)',
$x$            case when v_value > v_threshold
                       and not exists (select 1 from ops.task t
                                        where t.id = p_task and t.kind = 'discard')
                 then 'approval' else 'posted' end, p_task);$x$,
$x$            case when v_value > v_threshold then 'approval' else 'posted' end, p_task);$x$);
select core.patch_function('ops.discard_expired(uuid, numeric, text)',
$x$                             'item_id', v_t.item_id, 'qty', p_qty,
                             'reason', coalesce(v_t.discard_reason, 'expired'),$x$,
$x$                             'item_id', v_t.item_id, 'qty', p_qty, 'reason', 'expired',$x$);
select core.patch_function('ops.discard_expired(uuid, numeric, text)',
$x$  v_left := case when v_t.kind = 'discard'
                 then least(v_t.target_qty, inv.on_hand(v_t.item_id, v_t.delivery_node_id))
                 else (select b.remaining from inv.batch_rows(v_t.item_id, v_t.delivery_node_id) b
                        where b.batch_no = v_t.batch_no limit 1) end;$x$,
$x$  v_left := (select b.remaining from inv.batch_rows(v_t.item_id, v_t.delivery_node_id) b
              where b.batch_no = v_t.batch_no limit 1);$x$);
select core.patch_function('ops.discard_expired(uuid, numeric, text)',
$x$  if found and v_t.kind not in ('expiry', 'discard') then$x$,
$x$  if found and v_t.kind <> 'expiry' then$x$);
drop function ops.approve_discard(uuid, uuid);
drop function ops.ask_discard(uuid, uuid, numeric, text, text);
drop function inv.is_gm(uuid, uuid);
delete from ops.task_step where task_id in (select id from ops.task where kind = 'discard');
delete from ops.task where kind = 'discard';
alter table ops.task drop constraint task_discard;
alter table ops.task drop column discard_reason;
alter table inv.item drop column discard_approval;
select core.patch_function('inv.create_po(uuid, uuid, jsonb, text, text)',
$x$                         jsonb_build_object('unusual', inv.order_unusual(p_node, p_lines),
                           'why', inv.order_why(p_node, p_lines)));$x$,
$x$                         jsonb_build_object('unusual',
                           exists (select 1 from inv.unusual_calc(p_node, p_lines)),
                           'why', inv.unusual_why(p_node, p_lines)));$x$);
select core.patch_function('inv.request_supplies(uuid, jsonb, text, text)',
$x$                         jsonb_build_object('unusual', inv.order_unusual(p_node, p_lines),
                           'why', inv.order_why(p_node, p_lines)));$x$,
$x$                         jsonb_build_object('unusual',
                           exists (select 1 from inv.unusual_calc(p_node, p_lines)),
                           'why', inv.unusual_why(p_node, p_lines)));$x$);
drop function inv.order_why(uuid, jsonb);
drop function inv.order_value(jsonb);
drop function inv.order_unusual(uuid, jsonb);
select core.patch_function('ops.tasks_tick(timestamptz)',
$x$  -- today's par where it goes by the day (ADR 092)
  perform inv.apply_par_by_day(p_now);
$x$, '');
drop function inv.apply_par_by_day(timestamptz);
drop function inv.par_on(jsonb, numeric, date);
alter table inv.item_node drop column par_base, drop column par_by_day;
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind in (
  'one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill',
  'minibar_bill', 'sign_off', 'handover'));
