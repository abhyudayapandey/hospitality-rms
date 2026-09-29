-- migrate:up
-- Baseline: extensions and the business schemas from docs/LLD.md section 1.
-- No tables yet; each module adds its own with RLS + audit (CLAUDE.md rules 1 and 5).

-- Extensions get their own schema so SECURITY DEFINER functions can pin search_path
-- without public (ADR 002). A no-op where docker/init already created them.
create schema if not exists extensions;
create extension if not exists ltree schema extensions;

create schema core;
create schema hr;
create schema inv;
create schema ops;
create schema wf;
create schema ai;
create schema audit;

grant usage on schema core, hr, inv, ops, wf, ai, audit to app_rw, wf_executor;

-- migrate:down
drop schema audit;
drop schema ai;
drop schema wf;
drop schema ops;
drop schema inv;
drop schema hr;
drop schema core;
