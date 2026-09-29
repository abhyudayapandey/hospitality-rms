-- Business-process policy (bp_policy) for the MVP processes (docs/LLD.md section 4,
-- ADR 003). Authoritative for this tenant, like the domain policy matrix: upsert every
-- row, then delete this tenant's rows that are not listed.
-- step '*' = process-level actions (initiate, cancel). SELF = any active human user
-- acting on their own subject. Every step's group and escalateTo group needs an approve row
-- (checked by the workflow definition tests).

drop table if exists pg_temp.seed_bp_policy;
create temp table seed_bp_policy (process_type text, step text, grp text, action text);
insert into seed_bp_policy (process_type, step, grp, action) values
  ('STOCK_ADJUSTMENT', '*', 'STORE_KEEPER', 'initiate'),
  ('STOCK_ADJUSTMENT', '*', 'CHEF', 'initiate'),
  ('STOCK_ADJUSTMENT', '*', 'OUTLET_MANAGER', 'initiate'),
  ('STOCK_ADJUSTMENT', 'outlet_approval', 'OUTLET_MANAGER', 'approve'),
  ('STOCK_ADJUSTMENT', 'outlet_approval', 'AREA_MANAGER', 'approve'),     -- escalateTo

  ('PURCHASE_ORDER', '*', 'STORE_KEEPER', 'initiate'),
  ('PURCHASE_ORDER', '*', 'OUTLET_MANAGER', 'initiate'),
  ('PURCHASE_ORDER', '*', 'AI_AGENT', 'initiate'),
  ('PURCHASE_ORDER', 'outlet_approval', 'OUTLET_MANAGER', 'approve'),
  ('PURCHASE_ORDER', 'outlet_approval', 'AREA_MANAGER', 'approve'),       -- escalateTo
  ('PURCHASE_ORDER', 'area_approval', 'AREA_MANAGER', 'approve'),

  -- STORE_KEEPER initiates so the receiving OUTLET_MANAGER can approve receipt (rule 7)
  ('TRANSFER', '*', 'STORE_KEEPER', 'initiate'),
  ('TRANSFER', 'dispatch', 'HUB_MANAGER', 'approve'),
  ('TRANSFER', 'receipt', 'OUTLET_MANAGER', 'approve'),

  ('LEAVE', '*', 'SELF', 'initiate'),
  ('LEAVE', 'outlet_approval', 'OUTLET_MANAGER', 'approve'),
  ('LEAVE', 'outlet_approval', 'AREA_MANAGER', 'approve'),                -- escalateTo
  ('LEAVE', 'hr_approval', 'HR_ADMIN', 'approve'),

  ('SHIFT_SWAP', '*', 'SELF', 'initiate'),
  ('SHIFT_SWAP', 'outlet_approval', 'OUTLET_MANAGER', 'approve'),

  ('ROLE_CHANGE', '*', 'HR_ADMIN', 'initiate'),
  ('ROLE_CHANGE', 'security_approval', 'SECURITY_ADMIN', 'approve');

insert into core.bp_policy (tenant_id, process_type, step, group_id, action)
select '01920000-0000-7000-8000-000000000001', m.process_type, m.step, g.id, m.action
  from seed_bp_policy m
  join core.security_group g
    on g.code = m.grp and g.tenant_id = '01920000-0000-7000-8000-000000000001'
on conflict (process_type, step, group_id, action) do nothing;

delete from core.bp_policy bp
 where bp.tenant_id = '01920000-0000-7000-8000-000000000001'
   and not exists (
     select 1 from seed_bp_policy m
       join core.security_group g
         on g.code = m.grp and g.tenant_id = '01920000-0000-7000-8000-000000000001'
      where m.process_type = bp.process_type and m.step = bp.step
        and g.id = bp.group_id and m.action = bp.action);

drop table pg_temp.seed_bp_policy;
