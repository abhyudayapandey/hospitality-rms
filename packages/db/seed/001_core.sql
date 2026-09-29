-- Core seed: one tenant, org + delivery trees, security groups, domains, the policy
-- matrix (ADR 002) and one user per group. Idempotent: fixed ids + on conflict.
-- Codes are unique per tenant, so every code lookup is scoped by tenant_id.
-- The policy matrix is authoritative: re-seeding resets access and removes rows
-- that are not in the matrix.

-- Tenant
insert into core.tenant (id, name) values
  ('01920000-0000-7000-8000-000000000001', 'Demo Hospitality')
on conflict (id) do nothing;

-- Org tree: Company > Region > Area > Outlet A, Outlet B
insert into core.hierarchy_node (id, tenant_id, type, kind, name, parent_id, timezone) values
  ('01920000-0000-7000-8000-000000000101', '01920000-0000-7000-8000-000000000001', 'org', 'company', 'Company', null, null),
  ('01920000-0000-7000-8000-000000000102', '01920000-0000-7000-8000-000000000001', 'org', 'region', 'Region', '01920000-0000-7000-8000-000000000101', null),
  ('01920000-0000-7000-8000-000000000103', '01920000-0000-7000-8000-000000000001', 'org', 'area', 'Area', '01920000-0000-7000-8000-000000000102', null),
  ('01920000-0000-7000-8000-000000000104', '01920000-0000-7000-8000-000000000001', 'org', 'outlet', 'Outlet A', '01920000-0000-7000-8000-000000000103', 'Asia/Kolkata'),
  ('01920000-0000-7000-8000-000000000105', '01920000-0000-7000-8000-000000000001', 'org', 'outlet', 'Outlet B', '01920000-0000-7000-8000-000000000103', 'Asia/Kolkata'),
  -- Org-side home of the hub (people, roster), linked to the delivery Hub below
  ('01920000-0000-7000-8000-000000000106', '01920000-0000-7000-8000-000000000001', 'org', 'site', 'Hub', '01920000-0000-7000-8000-000000000102', 'Asia/Kolkata')
on conflict (id) do nothing;

-- Delivery tree: Company Supply Network > Hub > Outlet A, Outlet B
insert into core.hierarchy_node (id, tenant_id, type, kind, name, parent_id, timezone) values
  ('01920000-0000-7000-8000-000000000201', '01920000-0000-7000-8000-000000000001', 'delivery', 'network', 'Company Supply Network', null, null),
  ('01920000-0000-7000-8000-000000000202', '01920000-0000-7000-8000-000000000001', 'delivery', 'hub', 'Hub', '01920000-0000-7000-8000-000000000201', 'Asia/Kolkata'),
  ('01920000-0000-7000-8000-000000000203', '01920000-0000-7000-8000-000000000001', 'delivery', 'outlet', 'Outlet A', '01920000-0000-7000-8000-000000000202', 'Asia/Kolkata'),
  ('01920000-0000-7000-8000-000000000204', '01920000-0000-7000-8000-000000000001', 'delivery', 'outlet', 'Outlet B', '01920000-0000-7000-8000-000000000202', 'Asia/Kolkata')
on conflict (id) do nothing;

insert into core.node_link (tenant_id, org_node_id, delivery_node_id) values
  ('01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000104', '01920000-0000-7000-8000-000000000203'),
  ('01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000105', '01920000-0000-7000-8000-000000000204'),
  ('01920000-0000-7000-8000-000000000001', '01920000-0000-7000-8000-000000000106', '01920000-0000-7000-8000-000000000202')
on conflict do nothing;

-- Security groups
insert into core.security_group (tenant_id, code, name, kind)
select '01920000-0000-7000-8000-000000000001', code, name, kind from (values
  ('SELF', 'Self-service', 'user_based'),
  ('STAFF', 'Staff', 'role'),
  ('STORE_KEEPER', 'Store Keeper', 'role'),
  ('CHEF', 'Chef', 'role'),
  ('OUTLET_MANAGER', 'Outlet Manager', 'role'),
  ('AREA_MANAGER', 'Area Manager', 'role'),
  ('HUB_MANAGER', 'Hub Manager', 'role'),
  ('SUPPLY_VIEWER', 'Supply Viewer', 'role'),
  ('HR_ADMIN', 'HR Admin', 'role'),
  ('SECURITY_ADMIN', 'Security Admin', 'role'),
  ('AUDITOR', 'Auditor', 'role'),
  ('AI_AGENT', 'AI Agent', 'role')
) as g(code, name, kind)
on conflict (tenant_id, code) do nothing;

-- Domains
insert into core.domain (tenant_id, code, hierarchy_type)
select '01920000-0000-7000-8000-000000000001', code, ht from (values
  ('STOCK_LEVELS', 'delivery'),
  ('STOCK_ADJUSTMENTS', 'delivery'),
  ('PURCHASE_ORDERS', 'delivery'),
  ('TRANSFERS', 'delivery'),
  ('WORKERS', 'org'),
  ('COMPENSATION', 'org'),
  ('ROSTER', 'org'),
  ('ATTENDANCE', 'org'),
  ('LEAVE', 'org'),
  ('EVENTS', 'org'),
  ('AI_RECOMMENDATIONS', 'org'),
  ('DERIVED_STOCK_LEVELS', 'org'),
  ('DERIVED_PURCHASE_ORDERS', 'org'),
  ('DERIVED_TRANSFERS', 'org'),
  ('AUDIT', 'org'),
  ('SHIFT_SWAPS', 'org'),
  ('SECURITY_ROLES', 'org'),
  ('WF_CONFIG', 'org')
) as d(code, ht)
on conflict (tenant_id, code) do nothing;

-- Policy matrix (ADR 002). Authoritative for this tenant: upsert every row, then
-- delete this tenant's rows that are not in the matrix.
drop table if exists pg_temp.seed_policy_matrix;
create temp table seed_policy_matrix (grp text not null, dom text not null, access text not null);
insert into seed_policy_matrix (grp, dom, access) values
    ('STAFF', 'ROSTER', 'view'),
    ('STAFF', 'EVENTS', 'view'),

    ('STORE_KEEPER', 'STOCK_LEVELS', 'view'),
    ('STORE_KEEPER', 'STOCK_ADJUSTMENTS', 'modify'),
    ('STORE_KEEPER', 'PURCHASE_ORDERS', 'modify'),
    ('STORE_KEEPER', 'TRANSFERS', 'modify'),
    ('STORE_KEEPER', 'AI_RECOMMENDATIONS', 'view'),

    ('CHEF', 'STOCK_LEVELS', 'view'),
    ('CHEF', 'STOCK_ADJUSTMENTS', 'modify'),

    ('OUTLET_MANAGER', 'STOCK_LEVELS', 'view'),
    ('OUTLET_MANAGER', 'STOCK_ADJUSTMENTS', 'modify'),
    ('OUTLET_MANAGER', 'PURCHASE_ORDERS', 'modify'),
    ('OUTLET_MANAGER', 'TRANSFERS', 'modify'),
    ('OUTLET_MANAGER', 'WORKERS', 'view'),
    ('OUTLET_MANAGER', 'ROSTER', 'modify'),
    ('OUTLET_MANAGER', 'ATTENDANCE', 'modify'),
    ('OUTLET_MANAGER', 'LEAVE', 'view'),
    ('OUTLET_MANAGER', 'EVENTS', 'modify'),
    ('OUTLET_MANAGER', 'AI_RECOMMENDATIONS', 'modify'),
    ('OUTLET_MANAGER', 'SHIFT_SWAPS', 'view'),

    ('AREA_MANAGER', 'WORKERS', 'view'),
    ('AREA_MANAGER', 'ROSTER', 'view'),
    ('AREA_MANAGER', 'ATTENDANCE', 'view'),
    ('AREA_MANAGER', 'LEAVE', 'view'),
    ('AREA_MANAGER', 'EVENTS', 'view'),
    ('AREA_MANAGER', 'AI_RECOMMENDATIONS', 'view'),
    ('AREA_MANAGER', 'SHIFT_SWAPS', 'view'),
    ('AREA_MANAGER', 'DERIVED_STOCK_LEVELS', 'view'),
    ('AREA_MANAGER', 'DERIVED_PURCHASE_ORDERS', 'view'),
    ('AREA_MANAGER', 'DERIVED_TRANSFERS', 'view'),

    ('HUB_MANAGER', 'STOCK_LEVELS', 'view'),
    ('HUB_MANAGER', 'STOCK_ADJUSTMENTS', 'modify'),
    ('HUB_MANAGER', 'PURCHASE_ORDERS', 'view'),
    ('HUB_MANAGER', 'TRANSFERS', 'modify'),

    ('SUPPLY_VIEWER', 'STOCK_LEVELS', 'view'),

    ('HR_ADMIN', 'WORKERS', 'modify'),
    ('HR_ADMIN', 'COMPENSATION', 'modify'),
    ('HR_ADMIN', 'ROSTER', 'view'),
    ('HR_ADMIN', 'ATTENDANCE', 'view'),
    ('HR_ADMIN', 'LEAVE', 'modify'),
    ('HR_ADMIN', 'SECURITY_ROLES', 'modify'),

    ('SECURITY_ADMIN', 'AUDIT', 'view'),
    ('SECURITY_ADMIN', 'SECURITY_ROLES', 'view'),
    ('SECURITY_ADMIN', 'WF_CONFIG', 'view'),
    ('AUDITOR', 'SECURITY_ROLES', 'view'),
    ('HR_ADMIN', 'WF_CONFIG', 'view'),
    ('AUDITOR', 'AUDIT', 'view'),

    ('AI_AGENT', 'STOCK_LEVELS', 'view'),
    ('AI_AGENT', 'PURCHASE_ORDERS', 'view'),
    ('AI_AGENT', 'TRANSFERS', 'view'),
    ('AI_AGENT', 'WORKERS', 'view'),
    ('AI_AGENT', 'ROSTER', 'view'),
    ('AI_AGENT', 'ATTENDANCE', 'view'),
    ('AI_AGENT', 'LEAVE', 'view'),
    ('AI_AGENT', 'EVENTS', 'view'),
    ('AI_AGENT', 'AI_RECOMMENDATIONS', 'modify'),
    ('AI_AGENT', 'SHIFT_SWAPS', 'view'),

    ('SELF', 'WORKERS', 'view'),
    ('SELF', 'COMPENSATION', 'view'),
    ('SELF', 'ROSTER', 'view'),
    ('SELF', 'ATTENDANCE', 'modify'),
    ('SELF', 'LEAVE', 'modify'),
    ('SELF', 'SHIFT_SWAPS', 'modify');

insert into core.domain_policy (tenant_id, domain_id, group_id, access)
select '01920000-0000-7000-8000-000000000001', d.id, g.id, m.access
  from seed_policy_matrix m
  join core.security_group g on g.code = m.grp and g.tenant_id = '01920000-0000-7000-8000-000000000001'
  join core.domain d on d.code = m.dom and d.tenant_id = '01920000-0000-7000-8000-000000000001'
on conflict (domain_id, group_id) do update set access = excluded.access
  where core.domain_policy.access is distinct from excluded.access;

delete from core.domain_policy dp
 where dp.tenant_id = '01920000-0000-7000-8000-000000000001'
   and not exists (
     select 1 from seed_policy_matrix m
       join core.security_group g on g.code = m.grp and g.tenant_id = '01920000-0000-7000-8000-000000000001'
       join core.domain d on d.code = m.dom and d.tenant_id = '01920000-0000-7000-8000-000000000001'
      where g.id = dp.group_id and d.id = dp.domain_id);

drop table pg_temp.seed_policy_matrix;

-- Users: one per group (SUPPLY_VIEWER is held by the hub manager; SELF applies to all)
insert into core.app_user (id, tenant_id, kind, display_name) values
  ('01920000-0000-7000-8000-000000000301', '01920000-0000-7000-8000-000000000001', 'human', 'Sam Staff'),
  ('01920000-0000-7000-8000-000000000302', '01920000-0000-7000-8000-000000000001', 'human', 'Casey Chef'),
  ('01920000-0000-7000-8000-000000000303', '01920000-0000-7000-8000-000000000001', 'human', 'Kim Storekeeper'),
  ('01920000-0000-7000-8000-000000000304', '01920000-0000-7000-8000-000000000001', 'human', 'Olivia Outlet Manager'),
  ('01920000-0000-7000-8000-000000000305', '01920000-0000-7000-8000-000000000001', 'human', 'Aria Area Manager'),
  ('01920000-0000-7000-8000-000000000306', '01920000-0000-7000-8000-000000000001', 'human', 'Hugo Hub Manager'),
  ('01920000-0000-7000-8000-000000000307', '01920000-0000-7000-8000-000000000001', 'human', 'Harper HR Admin'),
  ('01920000-0000-7000-8000-000000000308', '01920000-0000-7000-8000-000000000001', 'human', 'Sasha Security Admin'),
  ('01920000-0000-7000-8000-000000000309', '01920000-0000-7000-8000-000000000001', 'human', 'Avery Auditor'),
  ('01920000-0000-7000-8000-000000000310', '01920000-0000-7000-8000-000000000001', 'service', 'Outlet Ops AI Agent')
on conflict (id) do nothing;

-- Role assignments. Every outlet worker holds STAFF at their org outlet.
insert into core.role_assignment (tenant_id, user_id, group_id, node_id, include_descendants, effective_from)
select '01920000-0000-7000-8000-000000000001', a.user_id::uuid, g.id, a.node_id::uuid, a.desc_, date '2026-01-01'
  from (values
    -- Sam Staff
    ('01920000-0000-7000-8000-000000000301', 'STAFF',          '01920000-0000-7000-8000-000000000104', true),
    -- Casey Chef
    ('01920000-0000-7000-8000-000000000302', 'STAFF',          '01920000-0000-7000-8000-000000000104', true),
    ('01920000-0000-7000-8000-000000000302', 'CHEF',           '01920000-0000-7000-8000-000000000203', true),
    -- Kim Storekeeper
    ('01920000-0000-7000-8000-000000000303', 'STAFF',          '01920000-0000-7000-8000-000000000104', true),
    ('01920000-0000-7000-8000-000000000303', 'STORE_KEEPER',   '01920000-0000-7000-8000-000000000203', true),
    -- org-side STORE_KEEPER so org-tree grants (AI_RECOMMENDATIONS view) apply (ADR 004)
    ('01920000-0000-7000-8000-000000000303', 'STORE_KEEPER',   '01920000-0000-7000-8000-000000000104', true),
    -- Olivia Outlet Manager (both trees)
    ('01920000-0000-7000-8000-000000000304', 'STAFF',          '01920000-0000-7000-8000-000000000104', true),
    ('01920000-0000-7000-8000-000000000304', 'OUTLET_MANAGER', '01920000-0000-7000-8000-000000000104', true),
    ('01920000-0000-7000-8000-000000000304', 'OUTLET_MANAGER', '01920000-0000-7000-8000-000000000203', true),
    -- Aria Area Manager
    ('01920000-0000-7000-8000-000000000305', 'AREA_MANAGER',   '01920000-0000-7000-8000-000000000103', true),
    -- Hugo Hub Manager: hub only, plus stock view below the hub
    ('01920000-0000-7000-8000-000000000306', 'HUB_MANAGER',    '01920000-0000-7000-8000-000000000202', false),
    ('01920000-0000-7000-8000-000000000306', 'SUPPLY_VIEWER',  '01920000-0000-7000-8000-000000000202', true),
    -- Company-level roles
    ('01920000-0000-7000-8000-000000000307', 'HR_ADMIN',       '01920000-0000-7000-8000-000000000101', true),
    ('01920000-0000-7000-8000-000000000308', 'SECURITY_ADMIN', '01920000-0000-7000-8000-000000000101', true),
    ('01920000-0000-7000-8000-000000000309', 'AUDITOR',        '01920000-0000-7000-8000-000000000101', true),
    -- AI agent at both roots
    ('01920000-0000-7000-8000-000000000310', 'AI_AGENT',       '01920000-0000-7000-8000-000000000101', true),
    ('01920000-0000-7000-8000-000000000310', 'AI_AGENT',       '01920000-0000-7000-8000-000000000201', true)
  ) as a(user_id, grp, node_id, desc_)
  join core.security_group g on g.code = a.grp and g.tenant_id = '01920000-0000-7000-8000-000000000001'
on conflict (user_id, group_id, node_id, effective_from) do nothing;
