-- migrate:up
-- A request that could not go through lets go of what it held (ADR 167, review H7 and M33).
--
-- When the executor gave up, wf.request became 'failed' but its subject kept its in-flight
-- status: a leave stayed 'submitted', so its days still counted against the balance and its
-- dates still refused a new ask (LEAVE_OVERLAP); a swap or a deactivation stayed open and its
-- unique index refused another; an order stayed 'submitted', so "Order it again" found it again.
-- Now the final failure runs wf.after_failure, which hands the request to its module's failure
-- hook: an HR subject becomes 'failed' (a new terminal status), an inventory subject becomes
-- 'cancelled' (the finished state its screens already read; the request's own 'failed' state
-- says why), and the person who asked is told in plain words. A transfer is the exception: its
-- request runs only after the goods were sent, so it stays and is received as usual.
--
-- Transient errors (serialisation, deadlock, lock wait, a dropped connection, a server going
-- down) no longer use up the three tries: they back off from 1 minute up to 30 minutes, for 12
-- tries (about four hours), counted apart from other errors.

alter table hr.leave_request drop constraint leave_request_status_check;
alter table hr.leave_request add constraint leave_request_status_check
  check (status in ('draft', 'submitted', 'approved', 'rejected', 'cancelled', 'failed'));
alter table hr.shift_swap drop constraint shift_swap_status_check;
alter table hr.shift_swap add constraint shift_swap_status_check check (status in
  ('proposed', 'declined', 'withdrawn', 'submitted', 'approved', 'rejected', 'cancelled',
   'reassigned', 'failed'));
alter table hr.role_change drop constraint role_change_status_check;
alter table hr.role_change add constraint role_change_status_check
  check (status in ('draft', 'submitted', 'applied', 'rejected', 'cancelled', 'failed'));
alter table hr.deactivation drop constraint deactivation_status_check;
alter table hr.deactivation add constraint deactivation_status_check
  check (status in ('draft', 'submitted', 'applied', 'rejected', 'cancelled', 'failed'));

-- ---------------------------------------------------------------------------
-- The failure hooks. Idempotent: each acts only on a subject still in flight.
-- ---------------------------------------------------------------------------

create function hr.on_failed(p_request uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_req wf.request;
  v_l hr.leave_request;
  v_sw hr.shift_swap;
  v_rc hr.role_change;
  v_dx hr.deactivation;
begin
  select * into v_req from wf.request where id = p_request;
  if not found or v_req.state <> 'failed' then
    return;
  end if;
  perform set_config('app.wf_request', p_request::text, true);
  case v_req.process_type
  when 'LEAVE' then
    update hr.leave_request set status = 'failed', decided_at = now()
     where wf_request_id = p_request and status = 'submitted'
    returning * into v_l;
    if v_l.id is not null then
      perform ops.notify(v_l.tenant_id, v_l.owner_user_id, 'leave_failed',
        'Your leave could not go through',
        to_char(v_l.from_date, 'DD Mon') || ' – ' || to_char(v_l.to_date, 'DD Mon')
          || '. These days are free again. You can ask again.',
        '/leave/' || v_l.id);
    end if;
  when 'SHIFT_SWAP' then
    update hr.shift_swap set status = 'failed', decided_at = now()
     where wf_request_id = p_request and status = 'submitted'
    returning * into v_sw;
    if v_sw.id is not null then
      perform ops.notify(v_sw.tenant_id, u, 'swap_failed', 'Shift swap could not go through',
        'Nothing changed on the roster.', '/roster/swaps/' || v_sw.id)
        from unnest(array[v_sw.owner_user_id, v_sw.to_user_id]) u;
    end if;
  when 'ROLE_CHANGE' then
    update hr.role_change set status = 'failed'
     where wf_request_id = p_request and status = 'submitted'
    returning * into v_rc;
    if v_rc.id is not null then
      perform ops.notify(v_rc.tenant_id, v_req.initiator_id, 'access_failed',
        'Access change could not go through',
        'For ' || hr.user_name(v_rc.target_user_id) || '. Nothing changed. You can ask again.',
        '/admin/users/' || v_rc.target_user_id);
    end if;
  when 'DEACTIVATION' then
    update hr.deactivation set status = 'failed'
     where wf_request_id = p_request and status = 'submitted'
    returning * into v_dx;
    if v_dx.id is not null then
      perform ops.notify(v_dx.tenant_id, v_req.initiator_id, 'deactivation_failed',
        'Deactivation could not go through',
        hr.user_name(v_dx.target_user_id) || ' can still sign in. You can ask again.',
        '/admin/users/' || v_dx.target_user_id);
    end if;
  else
    null;
  end case;
end $$;
revoke execute on function hr.on_failed(uuid) from public;

create function inv.on_failed(p_request uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_req wf.request;
  v_id uuid;
  v_what text;
  v_link text;
begin
  select * into v_req from wf.request where id = p_request;
  if not found or v_req.state <> 'failed' then
    return;
  end if;
  perform set_config('app.wf_request', p_request::text, true);
  case v_req.process_type
  when 'STOCK_ADJUSTMENT' then
    update inv.stock_adjustment set status = 'cancelled'
     where wf_request_id = p_request and status = 'submitted'
    returning id into v_id;
    v_what := 'Stock change could not go through';
    v_link := '/stock/adjustments/' || v_id;
  when 'PURCHASE_ORDER' then
    -- never released: "Order it again" now makes a new order (inv.order_for_request)
    update inv.purchase_order set status = 'cancelled'
     where wf_request_id = p_request and status = 'submitted'
    returning id into v_id;
    v_what := 'Order could not go through';
    v_link := '/stock/orders/' || v_id;
  when 'TRANSFER' then
    -- its request runs after the goods were sent: they are on the way and received as usual;
    -- only one never sent is let go
    update inv.transfer set status = 'cancelled'
     where wf_request_id = p_request and status = 'submitted' and dispatched_at is null
    returning id into v_id;
    v_what := 'Request could not go through';
    v_link := '/stock/transfers/' || v_id;
  else
    return;
  end case;
  if v_id is not null then
    perform ops.notify(v_req.tenant_id, v_req.initiator_id, 'request_failed', v_what,
                       'Nothing was moved. You can ask again.', v_link);
  end if;
end $$;
revoke execute on function inv.on_failed(uuid) from public;

-- Hands a failed request to its module's hook. A hook that fails is logged, never fatal: the
-- failure itself must be recorded.
create function wf.after_failure(p_request uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_type text;
begin
  select process_type into v_type from wf.request where id = p_request and state = 'failed';
  if not found then
    return;
  end if;
  begin
    if v_type in ('LEAVE', 'SHIFT_SWAP', 'ROLE_CHANGE', 'DEACTIVATION') then
      perform hr.on_failed(p_request);
    elsif v_type in ('STOCK_ADJUSTMENT', 'PURCHASE_ORDER', 'TRANSFER') then
      perform inv.on_failed(p_request);
    end if;
  exception when others then
    raise warning 'wf.after_failure % (%): %', p_request, v_type, sqlerrm;
  end;
end $$;
revoke execute on function wf.after_failure(uuid) from public;

-- ---------------------------------------------------------------------------
-- record_failure: transient errors back off longer and are counted apart (M33); the final
-- failure runs the hook (H7).
-- ---------------------------------------------------------------------------

alter table wf.outbox add column transient_attempts int not null default 0;

drop function wf.record_failure(uuid, text, timestamptz, boolean);
-- p_final: a business-rule failure (the executor decides by error code): the row fails at once.
-- p_transient: an error that passes by itself (SQLSTATE 40001, 40P01, 55P03, 08xxx, 57P0x):
-- retried 12 times, 1, 2, 4, 8, 16 then 30 minutes apart. Any other error: 3 tries, 30 s and
-- 2 min apart.
create function wf.record_failure(p_outbox_id uuid, p_error text, p_at timestamptz default now(),
                                  p_final boolean default false,
                                  p_transient boolean default false)
returns text
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_ob wf.outbox;
begin
  update wf.outbox o
     set attempts = o.attempts + 1,
         transient_attempts = o.transient_attempts + case when p_transient then 1 else 0 end,
         last_error = left(p_error, 2000),
         status = case
           when p_final then 'failed'
           when p_transient and o.transient_attempts + 1 >= 12 then 'failed'
           when not p_transient and o.attempts - o.transient_attempts + 1 >= 3 then 'failed'
           else 'pending' end,
         next_attempt_at = p_at + case
           when p_transient
             then make_interval(secs => least(60 * power(2, o.transient_attempts), 1800))
           else make_interval(secs => 30 * power(4, o.attempts - o.transient_attempts)) end
   where o.id = p_outbox_id and o.status = 'pending'
  returning * into v_ob;
  if not found then
    raise exception 'INVALID_STATE' using detail = 'outbox row is not pending';
  end if;
  update wf.request
     set state = case when v_ob.status = 'failed' then 'failed' else 'approved' end,
         failure_code = case when v_ob.status = 'failed'
                             then coalesce(substring(p_error from '^([A-Z][A-Z0-9_]+)'), 'HANDLER_ERROR')
                        end
   where id = v_ob.request_id and state = 'executing';
  if v_ob.status = 'failed' then
    perform wf.after_failure(v_ob.request_id);
  end if;
  return v_ob.status;
end $$;
revoke execute on function wf.record_failure(uuid, text, timestamptz, boolean, boolean) from public;
grant execute on function wf.record_failure(uuid, text, timestamptz, boolean, boolean) to wf_executor;

-- ---------------------------------------------------------------------------
-- Words
-- ---------------------------------------------------------------------------

-- a leave that could not go through holds nothing now: ask again
select core.patch_function('hr.leave_words(uuid)',
  $x$return 'It could not go through. Tell your manager.';$x$,
  $x$return 'It could not go through. You can ask again.';$x$);
select core.patch_function('hr.leave_state(uuid)',
  $x$when l.status = 'cancelled' then 'cancelled'$x$,
  $x$when l.status = 'cancelled' then 'cancelled'
    when l.status = 'failed' then 'failed'$x$);
-- Team -> Leave still lists it, as "could not go through"
select core.patch_function('hr.team_leave(uuid, date, date)',
  $x$and l.status in ('submitted', 'approved', 'rejected', 'cancelled')$x$,
  $x$and l.status in ('submitted', 'approved', 'rejected', 'cancelled', 'failed')$x$);

-- a request whose order could not go through says so, and to order it again (the order is
-- cancelled now, so it is looked for among the cancelled ones too)
select core.patch_function('inv.now_of(uuid, integer)',
  $x$   where po.for_transfer_id = p_transfer and po.status in ('submitted', 'released')
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc limit 1;$x$,
  $x$   where po.for_transfer_id = p_transfer
     and (po.status in ('submitted', 'released')
          or (po.status = 'cancelled' and po.closed_at is null
              and exists (select 1 from wf.request q
                           where q.id = po.wf_request_id and q.state = 'failed')))
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc, po.id desc limit 1;$x$);

-- ---------------------------------------------------------------------------
-- Repair: requests that failed before this hook let go of nothing. Production has one: a
-- LEAVE request that failed on 16 Oct (HANDLER_ERROR, shift_assignment_coming_off).
-- ---------------------------------------------------------------------------

select wf.after_failure(r.id)
  from wf.request r
 where r.state = 'failed'
 order by r.id;

-- migrate:down
select core.patch_function('inv.now_of(uuid, integer)',
  $x$   where po.for_transfer_id = p_transfer
     and (po.status in ('submitted', 'released')
          or (po.status = 'cancelled' and po.closed_at is null
              and exists (select 1 from wf.request q
                           where q.id = po.wf_request_id and q.state = 'failed')))
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc, po.id desc limit 1;$x$,
  $x$   where po.for_transfer_id = p_transfer and po.status in ('submitted', 'released')
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc limit 1;$x$);
select core.patch_function('hr.team_leave(uuid, date, date)',
  $x$and l.status in ('submitted', 'approved', 'rejected', 'cancelled', 'failed')$x$,
  $x$and l.status in ('submitted', 'approved', 'rejected', 'cancelled')$x$);
select core.patch_function('hr.leave_state(uuid)',
  $x$when l.status = 'cancelled' then 'cancelled'
    when l.status = 'failed' then 'failed'$x$,
  $x$when l.status = 'cancelled' then 'cancelled'$x$);
select core.patch_function('hr.leave_words(uuid)',
  $x$return 'It could not go through. You can ask again.';$x$,
  $x$return 'It could not go through. Tell your manager.';$x$);

drop function wf.record_failure(uuid, text, timestamptz, boolean, boolean);
create function wf.record_failure(p_outbox_id uuid, p_error text, p_at timestamptz default now(),
                                  p_final boolean default false)
returns text
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_ob wf.outbox;
begin
  update wf.outbox
     set attempts = attempts + 1,
         last_error = left(p_error, 2000),
         status = case when p_final or attempts + 1 >= 3 then 'failed' else 'pending' end,
         next_attempt_at = p_at + make_interval(secs => 30 * power(4, attempts))
   where id = p_outbox_id and status = 'pending'
  returning * into v_ob;
  if not found then
    raise exception 'INVALID_STATE' using detail = 'outbox row is not pending';
  end if;
  update wf.request
     set state = case when v_ob.status = 'failed' then 'failed' else 'approved' end,
         failure_code = case when v_ob.status = 'failed'
                             then coalesce(substring(p_error from '^([A-Z][A-Z0-9_]+)'), 'HANDLER_ERROR')
                        end
   where id = v_ob.request_id and state = 'executing';
  return v_ob.status;
end $$;
revoke execute on function wf.record_failure(uuid, text, timestamptz, boolean) from public;
grant execute on function wf.record_failure(uuid, text, timestamptz, boolean) to wf_executor;
alter table wf.outbox drop column transient_attempts;

drop function wf.after_failure(uuid);
drop function inv.on_failed(uuid);
drop function hr.on_failed(uuid);

update hr.deactivation set status = 'cancelled' where status = 'failed';
update hr.role_change set status = 'cancelled' where status = 'failed';
update hr.shift_swap set status = 'cancelled' where status = 'failed';
update hr.leave_request set status = 'cancelled' where status = 'failed';
alter table hr.deactivation drop constraint deactivation_status_check;
alter table hr.deactivation add constraint deactivation_status_check
  check (status in ('draft', 'submitted', 'applied', 'rejected', 'cancelled'));
alter table hr.role_change drop constraint role_change_status_check;
alter table hr.role_change add constraint role_change_status_check
  check (status in ('draft', 'submitted', 'applied', 'rejected', 'cancelled'));
alter table hr.shift_swap drop constraint shift_swap_status_check;
alter table hr.shift_swap add constraint shift_swap_status_check check (status in
  ('proposed', 'declined', 'withdrawn', 'submitted', 'approved', 'rejected', 'cancelled',
   'reassigned'));
alter table hr.leave_request drop constraint leave_request_status_check;
alter table hr.leave_request add constraint leave_request_status_check
  check (status in ('draft', 'submitted', 'approved', 'rejected', 'cancelled'));
