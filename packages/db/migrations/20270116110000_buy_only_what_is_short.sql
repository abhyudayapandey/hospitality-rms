-- migrate:up

-- Buy what's short buys only what's short (ADR 162): a line the store has in full is sent, not
-- bought. Before, a line with nothing short fell back to the whole quantity asked, so every
-- line went on the order. Nothing short at all: NOTHING_SHORT, send it instead.
select core.patch_function('inv.order_for_request(uuid,jsonb)',
  $x$coalesce(nullif(greatest(tl.requested_qty - coalesce(sl.on_hand, 0), 0), 0),
                            tl.requested_qty) as qty$x$,
  $x$greatest(tl.requested_qty - coalesce(sl.on_hand, 0), 0) as qty$x$);
select core.patch_function('inv.order_for_request(uuid,jsonb)',
  $x$             where tl.transfer_id = p_transfer) x;
  end if;$x$,
  $x$             where tl.transfer_id = p_transfer) x
     where x.qty > 0;
    if v_lines is null then
      perform inv.fail('NOTHING_SHORT', 'the store has all of it: send it');
    end if;
  end if;$x$);

-- migrate:down

select core.patch_function('inv.order_for_request(uuid,jsonb)',
  $x$             where tl.transfer_id = p_transfer) x
     where x.qty > 0;
    if v_lines is null then
      perform inv.fail('NOTHING_SHORT', 'the store has all of it: send it');
    end if;
  end if;$x$,
  $x$             where tl.transfer_id = p_transfer) x;
  end if;$x$);
select core.patch_function('inv.order_for_request(uuid,jsonb)',
  $x$greatest(tl.requested_qty - coalesce(sl.on_hand, 0), 0) as qty$x$,
  $x$coalesce(nullif(greatest(tl.requested_qty - coalesce(sl.on_hand, 0), 0), 0),
                            tl.requested_qty) as qty$x$);
