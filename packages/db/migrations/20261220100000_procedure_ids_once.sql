-- migrate:up
-- inv.prep_procedure's row filter (ADR 078) called inv.visible_prep_item_ids() and
-- menu.visible_menu_item_ids() once per procedure row, not once per query: 6 to 10 s for every
-- read of the table, whoever reads it, and the reason the all-users RLS check doubled in
-- length. Both lists are now worked out once.

create or replace function inv.visible_procedure_ids() returns uuid[]
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
declare
  v_preps uuid[] := inv.visible_prep_item_ids();
  v_dishes uuid[] := menu.visible_menu_item_ids();
begin
  return (select coalesce(array_agg(p.id), '{}')
            from inv.prep_procedure p
           where p.tenant_id = core.my_tenant()
             and (p.prep_item_id = any (v_preps) or p.menu_item_id = any (v_dishes)));
end $$;

-- migrate:down
create or replace function inv.visible_procedure_ids() returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select coalesce(array_agg(p.id), '{}')
    from inv.prep_procedure p
   where p.tenant_id = core.my_tenant()
     and (p.prep_item_id = any (inv.visible_prep_item_ids())
          or p.menu_item_id = any (menu.visible_menu_item_ids()));
$$;
