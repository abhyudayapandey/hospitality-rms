-- migrate:up
-- One word, Request (ADR 144): what people ask for is a Request, whoever asks and wherever it
-- comes from; buying from a supplier is a request to buy, and the Main Store's order an Order.
-- Titles of new tasks and alerts only: steps keep their action words (Send, Receive, Collect).

select core.patch_function('inv.raise_staff_ask(uuid,jsonb,text,text)',
  $x$left(v_me.display_name || ' asks for ' || inv.staff_ask_items_text(v_a.id), 200)$x$,
  $x$left('Request from ' || v_me.display_name || ': ' || inv.staff_ask_items_text(v_a.id), 200)$x$);

select core.patch_function('inv.after_step()',
  $x$'To approve: the ' || inv.short_name(po.delivery_node_id) || ' asks to buy '$x$,
  $x$'To approve: request from the ' || inv.short_name(po.delivery_node_id) || ' to buy '$x$);
select core.patch_function('inv.after_step()',
  $x$then 'The ' || inv.short_name(v_t.to_node_id) || ' asks for ' || v_what
                          else 'To approve: the ' || inv.short_name(v_t.to_node_id) || ' asks '
                                 || case when inv.is_main_store(v_t.from_node_id)
                                         then 'the Main Store'
                                         else 'the ' || inv.short_name(v_t.from_node_id) end
                                 || ' for ' || v_what end,$x$,
  $x$then 'Request from the ' || inv.short_name(v_t.to_node_id) || ': ' || v_what
                          else 'To approve: request from the ' || inv.short_name(v_t.to_node_id)
                                 || ' to '
                                 || case when inv.is_main_store(v_t.from_node_id)
                                         then 'the Main Store'
                                         else 'the ' || inv.short_name(v_t.from_node_id) end
                                 || ': ' || v_what end,$x$);

select core.patch_function('inv.notify_ordered(uuid,uuid)',
  $x$'Your supply request was ordered'$x$, $x$'Your request was ordered'$x$);
select core.patch_function('inv.notify_received(uuid,uuid)',
  $x$case when v_open = 0 then 'Your supplies were received'
                          else 'Part of your supplies was received' end,
                     case when v_open = 0 then 'The supply request is complete: the materials are in.'$x$,
  $x$case when v_open = 0 then 'Your request arrived'
                          else 'Part of your request arrived' end,
                     case when v_open = 0 then 'Everything you asked for is in.'$x$);

-- open asks waiting on a head read the same way
update ops.task
   set title = left(regexp_replace(title, '^(.*) asks for ', 'Request from \1: '), 200)
 where kind = 'ask' and status = 'open' and title ~ ' asks for ';

-- migrate:down
update ops.task
   set title = left(regexp_replace(title, '^Request from ([^:]*): ', '\1 asks for '), 200)
 where kind = 'ask' and status = 'open' and title ~ '^Request from ';

select core.patch_function('inv.notify_received(uuid,uuid)',
  $x$case when v_open = 0 then 'Your request arrived'
                          else 'Part of your request arrived' end,
                     case when v_open = 0 then 'Everything you asked for is in.'$x$,
  $x$case when v_open = 0 then 'Your supplies were received'
                          else 'Part of your supplies was received' end,
                     case when v_open = 0 then 'The supply request is complete: the materials are in.'$x$);
select core.patch_function('inv.notify_ordered(uuid,uuid)',
  $x$'Your request was ordered'$x$, $x$'Your supply request was ordered'$x$);
select core.patch_function('inv.after_step()',
  $x$then 'Request from the ' || inv.short_name(v_t.to_node_id) || ': ' || v_what
                          else 'To approve: request from the ' || inv.short_name(v_t.to_node_id)
                                 || ' to '
                                 || case when inv.is_main_store(v_t.from_node_id)
                                         then 'the Main Store'
                                         else 'the ' || inv.short_name(v_t.from_node_id) end
                                 || ': ' || v_what end,$x$,
  $x$then 'The ' || inv.short_name(v_t.to_node_id) || ' asks for ' || v_what
                          else 'To approve: the ' || inv.short_name(v_t.to_node_id) || ' asks '
                                 || case when inv.is_main_store(v_t.from_node_id)
                                         then 'the Main Store'
                                         else 'the ' || inv.short_name(v_t.from_node_id) end
                                 || ' for ' || v_what end,$x$);
select core.patch_function('inv.after_step()',
  $x$'To approve: request from the ' || inv.short_name(po.delivery_node_id) || ' to buy '$x$,
  $x$'To approve: the ' || inv.short_name(po.delivery_node_id) || ' asks to buy '$x$);
select core.patch_function('inv.raise_staff_ask(uuid,jsonb,text,text)',
  $x$left('Request from ' || v_me.display_name || ': ' || inv.staff_ask_items_text(v_a.id), 200)$x$,
  $x$left(v_me.display_name || ' asks for ' || inv.staff_ask_items_text(v_a.id), 200)$x$);
