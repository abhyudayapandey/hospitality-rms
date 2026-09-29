-- Cluster-level setup for local docker and CI. Runs as the postgres superuser
-- against the outlet_ops database. On RDS the equivalent is done once at
-- provisioning time (see docs/decisions/001-monorepo-tooling.md).
-- Passwords here are local-only and must never be used in a deployed environment.

create role migrator login password 'migrator_local';
create role app_rw login password 'app_rw_local' nobypassrls;
create role wf_executor login password 'wf_executor_local' nobypassrls;

grant create, connect on database outlet_ops to migrator;
-- Lets DB tests build fixtures as migrator and then SET LOCAL ROLE app_rw / wf_executor
-- inside a rolled-back transaction (ADR 002). Grants no extra privileges to app_rw.
grant app_rw, wf_executor to migrator;
grant connect on database outlet_ops to app_rw, wf_executor;
-- dbmate keeps its schema_migrations table in public (PG15+ no longer grants CREATE there).
grant create on schema public to migrator;

-- ltree is a trusted extension, but create it up front so migrations never need superuser.
create extension if not exists ltree;
