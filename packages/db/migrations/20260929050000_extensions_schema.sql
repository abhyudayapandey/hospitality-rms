-- migrate:up
-- Extensions live in schema `extensions`, not public, so SECURITY DEFINER functions
-- can pin search_path to pg_catalog, core, extensions (ADR 002).
-- docker/init and the baseline migration create ltree there. This migration covers
-- databases migrated before that change: it moves ltree when it can, or fails with
-- the superuser command to run (member objects of a trusted extension are owned by
-- the bootstrap superuser, so migrator usually cannot move them).

create schema if not exists extensions;

do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'ltree';
  if v_schema is null then
    create extension ltree schema extensions;
  elsif v_schema <> 'extensions' then
    begin
      alter extension ltree set schema extensions;
    exception when insufficient_privilege then
      raise exception 'LTREE_WRONG_SCHEMA'
        using detail = format('ltree is in schema %s and migrator does not own it', v_schema),
              hint = 'As a superuser run: alter extension ltree set schema extensions;';
    end;
  end if;
end $$;

grant usage on schema extensions to app_rw, wf_executor;

-- migrate:down
-- Leave ltree where it is: later migrations and data depend on it.
revoke usage on schema extensions from app_rw, wf_executor;
