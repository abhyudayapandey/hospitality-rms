#!/bin/bash
# Creates or updates the database roles from their SSM secrets (idempotent; also applies
# password rotations). migrator owns the schema; app_rw and wf_executor get no BYPASSRLS.
# app_rw/wf_executor are deliberately NOT granted to migrator here: that grant exists
# only in local/CI for tests (ADR 005). platform_loader (ADR 012) is the one role that
# bypasses RLS; it has no DDL rights. Passwords go via stdin, never argv.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

{
  printf "\\\\set mig '%s'\n\\\\set app '%s'\n\\\\set wf '%s'\n\\\\set pl '%s'\n" \
    "$(cat "$OO_CREDS/migrator")" "$(cat "$OO_CREDS/app_rw")" "$(cat "$OO_CREDS/wf_executor")" \
    "$(cat "$OO_CREDS/platform_loader")"
  cat <<'SQL'
select 'create role migrator' where not exists (select from pg_roles where rolname = 'migrator') \gexec
select 'create role app_rw' where not exists (select from pg_roles where rolname = 'app_rw') \gexec
select 'create role wf_executor' where not exists (select from pg_roles where rolname = 'wf_executor') \gexec
select 'create role platform_loader' where not exists (select from pg_roles where rolname = 'platform_loader') \gexec
alter role migrator with login nosuperuser nocreaterole nocreatedb nobypassrls password :'mig';
alter role app_rw with login nosuperuser nocreaterole nocreatedb nobypassrls password :'app';
alter role wf_executor with login nosuperuser nocreaterole nocreatedb nobypassrls password :'wf';
-- the platform worker's loader (ADR 012): writes customer data across customers, so it
-- bypasses RLS; no DDL (owns nothing, no CREATE), and only the worker has its password
alter role platform_loader with login nosuperuser nocreaterole nocreatedb bypassrls password :'pl';
revoke app_rw, wf_executor, platform_loader from migrator;
revoke all on database outlet_ops from public;
-- temporary: migrations may define pg_temp helpers that go when the session ends
-- (20261101100000_report_breakdowns patches functions with one)
grant create, connect, temporary on database outlet_ops to migrator;
grant connect on database outlet_ops to app_rw, wf_executor, platform_loader;
revoke create on schema public from public;
grant create on schema public to migrator;
create schema if not exists extensions authorization migrator;
create extension if not exists ltree schema extensions;
create extension if not exists pg_cron;
SQL
} | psql_super -d outlet_ops

log "database roles and extensions in place"
