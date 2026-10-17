-- migrate:up
-- Money only for whoever reads it (ADR 166, review H2 and M10). The adjustment page showed the
-- adjustment's ₹ and each line's qty × unit cost to anyone with STOCK_ADJUSTMENTS view, a
-- chef de partie or head bartender included; an order's approval reason ("Worth ₹X, above
-- ₹Y") went to every PURCHASE_ORDERS viewer while its total was hidden from them.

-- whether the caller reads an adjustment's money: the store's money readers (ADR 145) and
-- whoever may approve it now
create function inv.sees_adjustment_money(p_adjustment uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
  select coalesce((
    select inv.sees_store_money(a.delivery_node_id)
           or exists (select 1 from wf.request r
                        join wf.step_instance s on s.request_id = r.id and s.state = 'pending'
                       where r.id = a.wf_request_id and r.state = 'in_approval'
                         and wf.can_act_on_step(core.current_user_id(), s, r.process_type))
      from inv.stock_adjustment a
     where a.id = p_adjustment and a.tenant_id = core.my_tenant()), false);
$$;
revoke execute on function inv.sees_adjustment_money(uuid) from public;
grant execute on function inv.sees_adjustment_money(uuid) to app_rw;

-- an order's reason names its value only to its approver and its money readers
select core.patch_function('inv.po_approval(uuid)',
  $o$v_r.payload ->> 'why', v_may,$o$,
  $n$case when v_may or inv.po_sees_money(p_po) or strpos(v_r.payload ->> 'why', '₹') = 0
         then v_r.payload ->> 'why'
         else 'Over the amount that needs approval' end, v_may,$n$);

-- migrate:down
select core.patch_function('inv.po_approval(uuid)',
  $o$case when v_may or inv.po_sees_money(p_po) or strpos(v_r.payload ->> 'why', '₹') = 0
         then v_r.payload ->> 'why'
         else 'Over the amount that needs approval' end, v_may,$o$,
  $n$v_r.payload ->> 'why', v_may,$n$);
drop function inv.sees_adjustment_money(uuid);
