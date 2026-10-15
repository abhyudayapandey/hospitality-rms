-- migrate:up
-- What the ask and order forms say before sending (ADR 145): whether it will wait for a yes and
-- whose, worked out the way inv.request_transfer and inv.po_payload decide it. Before, the forms
-- only knew the "unusual" rule and always named the department head, even where the outlet's
-- rules have the GM approve every request or every order (ADR 115).
--   approver: 'gm', 'department_head' or null (goes through on its own)
--   rule:     'every' (the outlet approves every one), 'above' (over a value), 'unusual'
--   why:      a line per reason, for the unusual and value rules
create function inv.approval_preview(p_node uuid, p_lines jsonb, p_kind text)
returns table (approver text, rule text, why text[])
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_rule text;
  v_unusual text[];
  v_rfm boolean;
begin
  perform wf.me();
  if p_node is null
     or not exists (select 1 from core.hierarchy_node where id = p_node and type = 'delivery'
                       and tenant_id = core.my_tenant())
     or not (core.can('STOCK_LEVELS', 'view', null, p_node)
             or core.can('PURCHASE_ORDERS', 'view', null, p_node)
             or core.can('TRANSFERS', 'view', null, p_node)) then
    perform inv.fail('NOT_AUTHORISED', 'view stock at ' || coalesce(p_node::text, 'nowhere'));
  end if;
  perform inv.check_lines(p_lines, p_node);
  select coalesce(array_agg(case u.reason
                              when 'off_menu' then format('%s: not on the menu', i.name)
                              else format('%s: %s %s, usual %s %s a week', i.name,
                                          trim_scale(u.qty), i.base_uom,
                                          trim_scale(round(u.weekly_avg, 2)), i.base_uom)
                            end order by i.name), '{}')
    into v_unusual
    from inv.unusual_calc(p_node, p_lines) u join inv.item i on i.id = u.item_id;

  if p_kind = 'order' then
    v_rule := inv.stock_rule(p_node, 'purchase_approval');
    if not inv.order_unusual(p_node, p_lines) then
      return;
    end if;
    return query select
      case when inv.stock_rule(p_node, 'purchase_approver') = 'gm' then 'gm'
           else 'department_head' end,
      case when v_rule = 'every' then 'every' when v_rule like 'above:%' then 'above'
           else 'unusual' end,
      case when v_rule = 'every' then '{}'::text[]
           when v_rule like 'above:%' then array[inv.order_why(p_node, p_lines)]
           else v_unusual end;
    return;
  end if;

  -- a stock request: the GM where the outlet's rule says so and it comes from a store of the
  -- same outlet (inv.transfer_needs_gm), else the department head for an unusual request for
  -- material into a department's store
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)
              where inv.transfer_needs_gm(inv.source_for(p_node, l.item_id), p_node)) then
    return query select 'gm', 'every', '{}'::text[];
    return;
  end if;
  v_rfm := exists (select 1 from core.node_link nl
                     join core.hierarchy_node o on o.id = nl.org_node_id and o.kind = 'department'
                    where nl.delivery_node_id = p_node);
  if v_rfm and inv.stock_rule(p_node, 'request_approval') = 'unusual'
     and cardinality(v_unusual) > 0 then
    return query select 'department_head', 'unusual', v_unusual;
  end if;
end $$;
revoke execute on function inv.approval_preview(uuid, jsonb, text) from public;
grant execute on function inv.approval_preview(uuid, jsonb, text) to app_rw;

-- migrate:down
drop function inv.approval_preview(uuid, jsonb, text);
