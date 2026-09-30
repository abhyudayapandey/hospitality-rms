-- Core seed: one tenant, org + delivery trees and one user per group. Idempotent: fixed
-- ids + on conflict. Codes are unique per tenant, so every code lookup is scoped by
-- tenant_id. Access (groups, domains, the policy matrix, bp_policy) comes from the
-- product sync that db:seed runs afterwards (ADR 009).

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

-- Security groups this seed assigns. The full product set of groups, domains, the policy
-- matrix and bp_policy are written by the product sync (sync-defs, part of db:seed).
insert into core.security_group (tenant_id, code, name, kind)
select '01920000-0000-7000-8000-000000000001', code, name, kind from (values
  ('SELF', 'Self-service', 'user_based'),
  ('STAFF', 'Staff', 'role'),
  ('STOCK_USER', 'Stock User', 'role'),
  ('STORE_KEEPER', 'Store Keeper', 'role'),
  ('OUTLET_MANAGER', 'Outlet Manager', 'role'),
  ('AREA_MANAGER', 'Area Manager', 'role'),
  ('HUB_MANAGER', 'Hub Manager', 'role'),
  ('SUPPLY_VIEWER', 'Supply Viewer', 'role'),
  ('HR_ADMIN', 'HR Admin', 'role'),
  ('SECURITY_ADMIN', 'Security Admin', 'role'),
  ('AUDITOR', 'Auditor', 'role'),
  ('AI_AGENT', 'AI Agent', 'role'),
  ('ACCOUNT_OWNER', 'Account Owner', 'admin')
) as g(code, name, kind)
on conflict (tenant_id, code) do nothing;

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
  ('01920000-0000-7000-8000-000000000310', '01920000-0000-7000-8000-000000000001', 'service', 'Outlet Ops AI Agent'),
  ('01920000-0000-7000-8000-000000000319', '01920000-0000-7000-8000-000000000001', 'human', 'Owen Account Owner')
on conflict (id) do nothing;

-- Role assignments. Every outlet worker holds STAFF at their org outlet.
insert into core.role_assignment (tenant_id, user_id, group_id, node_id, include_descendants, effective_from)
select '01920000-0000-7000-8000-000000000001', a.user_id::uuid, g.id, a.node_id::uuid, a.desc_, date '2026-01-01'
  from (values
    -- Sam Staff
    ('01920000-0000-7000-8000-000000000301', 'STAFF',          '01920000-0000-7000-8000-000000000104', true),
    -- Casey Chef
    ('01920000-0000-7000-8000-000000000302', 'STAFF',          '01920000-0000-7000-8000-000000000104', true),
    ('01920000-0000-7000-8000-000000000302', 'STOCK_USER',     '01920000-0000-7000-8000-000000000203', true),
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
    ('01920000-0000-7000-8000-000000000319', 'ACCOUNT_OWNER',  '01920000-0000-7000-8000-000000000101', true),
    -- AI agent at both roots
    ('01920000-0000-7000-8000-000000000310', 'AI_AGENT',       '01920000-0000-7000-8000-000000000101', true),
    ('01920000-0000-7000-8000-000000000310', 'AI_AGENT',       '01920000-0000-7000-8000-000000000201', true)
  ) as a(user_id, grp, node_id, desc_)
  join core.security_group g on g.code = a.grp and g.tenant_id = '01920000-0000-7000-8000-000000000001'
on conflict (user_id, group_id, node_id, effective_from) do nothing;
