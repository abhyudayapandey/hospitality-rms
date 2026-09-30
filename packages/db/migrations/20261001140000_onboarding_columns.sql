-- migrate:up
-- Columns the onboarding files carry (ADR 009, docs/onboarding/test-data):
--   * suppliers have a code (file 09) so items and item locations can refer to them
--   * items have a standard unit cost and a preferred supplier (file 10)
--   * a count tolerance can be a percentage of the expected quantity (file 11); a fixed
--     quantity tolerance still wins where both are set
--   * shift templates are unique per place, name and job role (file 16), so loading the
--     same file twice updates them

alter table inv.supplier add column code text check (code ~ '^[A-Z0-9][A-Z0-9_.-]*$');
create unique index supplier_code on inv.supplier (tenant_id, code) where code is not null;

alter table inv.item
  add column standard_unit_cost numeric(14,2) check (standard_unit_cost >= 0),
  add column preferred_supplier_id uuid references inv.supplier (id);

alter table inv.item_node
  add column count_tolerance_pct numeric(5,2)
    check (count_tolerance_pct >= 0 and count_tolerance_pct <= 100);

create unique index shift_template_natural
  on hr.shift_template (tenant_id, org_node_id, name, role_code);

do $$
declare
  v_src text := pg_get_functiondef('inv.submit_count(uuid, jsonb)'::regprocedure);
  v_old text := 'coalesce(n.count_tolerance_qty, 0) as tolerance';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'inv.submit_count changed; update this migration';
  end if;
  execute replace(v_src, v_old,
    'coalesce(n.count_tolerance_qty, abs(cl.system_qty) * n.count_tolerance_pct / 100, 0) as tolerance');
end $$;

-- migrate:down
do $$
begin
  execute replace(pg_get_functiondef('inv.submit_count(uuid, jsonb)'::regprocedure),
    'coalesce(n.count_tolerance_qty, abs(cl.system_qty) * n.count_tolerance_pct / 100, 0) as tolerance',
    'coalesce(n.count_tolerance_qty, 0) as tolerance');
end $$;
drop index hr.shift_template_natural;
alter table inv.item_node drop column count_tolerance_pct;
alter table inv.item drop column standard_unit_cost, drop column preferred_supplier_id;
drop index inv.supplier_code;
alter table inv.supplier drop column code;
