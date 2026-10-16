-- migrate:up

-- Quantities in words as the screen says them (ADR 162, lib/qty.ts): whole numbers for things
-- counted one by one (g, ml, each, a can, a pack…; a bar's part bottle stays, ADR 015), at most 2
-- decimals otherwise, and the unit said as many ("24 bottles", "1 bottle"; measures as they are).
create function inv.unit_word(p_uom text, p_qty numeric) returns text
language sql immutable
as $$
  select case
    when coalesce(btrim(p_uom), '') = '' then ''
    when lower(btrim(p_uom)) in ('g', 'kg', 'mg', 'ml', 'cl', 'l', 'ltr', 'each', 'pc', 'pcs')
      or abs(p_qty) = 1 or btrim(p_uom) ~* 's$' then btrim(p_uom)
    when btrim(p_uom) ~* '(x|ch|sh)$' then btrim(p_uom) || 'es'
    else btrim(p_uom) || 's'
  end;
$$;

create function inv.qty_text(p_qty numeric, p_uom text) returns text
language sql immutable
as $$
  with q as (
    select trim_scale(round(coalesce(p_qty, 0),
             case when lower(btrim(coalesce(p_uom, ''))) in
                    ('g', 'ml', 'each', 'pc', 'pcs', 'can', 'cans', 'tin', 'tins', 'pack', 'packs',
                     'packet', 'packets', 'box', 'boxes', 'roll', 'rolls', 'piece', 'pieces')
                  then 0 else 2 end)) as n
  )
  select btrim(n::text || ' ' || inv.unit_word(p_uom, n)) from q;
$$;
grant execute on function inv.unit_word(text, numeric), inv.qty_text(numeric, text) to app_rw;

do $$
declare
  v text;
begin
  v := pg_get_functiondef('inv.unusual_why(uuid,jsonb)'::regprocedure);
  v := regexp_replace(v,
    'format\(''%s: %s %s, usual %s %s a week'', i\.name, trim_scale\(u\.qty\), i\.base_uom,\s*trim_scale\(u\.weekly_avg\), i\.base_uom\)',
    'format(''%s: %s, usual %s a week'', i.name, inv.qty_text(u.qty, i.base_uom), inv.qty_text(u.weekly_avg, i.base_uom))');
  if strpos(v, 'inv.qty_text') = 0 then
    raise exception 'inv.unusual_why: the part to change is not there';
  end if;
  execute v;

  v := pg_get_functiondef('inv.approval_preview(uuid,jsonb,text)'::regprocedure);
  v := regexp_replace(v,
    'format\(''%s: %s %s, usual %s %s a week'', i\.name,\s*trim_scale\(u\.qty\), i\.base_uom,\s*trim_scale\(round\(u\.weekly_avg, 2\)\), i\.base_uom\)',
    'format(''%s: %s, usual %s a week'', i.name, inv.qty_text(u.qty, i.base_uom), inv.qty_text(u.weekly_avg, i.base_uom))');
  if strpos(v, 'inv.qty_text') = 0 then
    raise exception 'inv.approval_preview: the part to change is not there';
  end if;
  execute v;
end $$;

-- migrate:down

select core.patch_function('inv.unusual_why(uuid,jsonb)',
  $x$format('%s: %s, usual %s a week', i.name, inv.qty_text(u.qty, i.base_uom), inv.qty_text(u.weekly_avg, i.base_uom))$x$,
  $x$format('%s: %s %s, usual %s %s a week', i.name, trim_scale(u.qty), i.base_uom,
                         trim_scale(u.weekly_avg), i.base_uom)$x$);
select core.patch_function('inv.approval_preview(uuid,jsonb,text)',
  $x$format('%s: %s, usual %s a week', i.name, inv.qty_text(u.qty, i.base_uom), inv.qty_text(u.weekly_avg, i.base_uom))$x$,
  $x$format('%s: %s %s, usual %s %s a week', i.name,
                                          trim_scale(u.qty), i.base_uom,
                                          trim_scale(round(u.weekly_avg, 2)), i.base_uom)$x$);
drop function inv.qty_text(numeric, text);
drop function inv.unit_word(text, numeric);
