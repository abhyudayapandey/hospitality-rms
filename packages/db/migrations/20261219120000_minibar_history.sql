-- migrate:up
-- What was added to guests' bills (ADR 119): each minibar check marked on the bill between two
-- days (the outlet's business days), with what was used, the amount, who checked it and who
-- added it to the bill. For whoever reads the outlet's minibars; the screen shows it to
-- whoever bills them, as it does what is still to charge.

create function ops.minibar_charged(p_outlet uuid, p_from date, p_to date)
returns table (id uuid, room text, checked_at timestamptz, checked_by text, used jsonb,
               charge numeric, charged_at timestamptz, charged_by text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
begin
  if not core.can('MINIBAR', 'view', p_outlet, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('MINIBAR view at %s', p_outlet);
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    perform ops.fail('INVALID_VALUE', 'a period of a year at most');
  end if;
  return query
    select c.id, r.number, c.checked_at, uc.display_name,
           coalesce((select jsonb_agg(jsonb_build_object('item', i.name, 'qty', l.used_qty,
                                                         'price', l.price) order by i.name)
                       from ops.minibar_check_line l join inv.item i on i.id = l.item_id
                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),
           c.charge, c.charged_at, ub.display_name
      from ops.minibar_check c
      join ops.room r on r.id = c.room_id
      left join core.app_user uc on uc.id = c.created_by
      left join core.app_user ub on ub.id = c.charged_by
     where c.org_node_id = p_outlet and c.charged_at is not null
       and rpt.business_date(c.charged_at, ops.tz_of(p_outlet)) between p_from and p_to
     order by c.charged_at desc;
end $$;

revoke execute on function ops.minibar_charged(uuid, date, date) from public;
grant execute on function ops.minibar_charged(uuid, date, date) to app_rw;

-- migrate:down
drop function ops.minibar_charged(uuid, date, date);
