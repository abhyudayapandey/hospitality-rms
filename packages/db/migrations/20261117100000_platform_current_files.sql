-- migrate:up
-- Adding an outlet from a template (ADR 062) adds rows to the customer's complete set of
-- onboarding files, then dry runs and applies them like any import (the loader treats the
-- files as the whole truth). This says where that set is: the upload of the last import that
-- was applied, or, for a customer created in the console and never imported, what it was
-- created with. Platform admins only; nothing about the files' contents is returned.
create function platform.current_files(p_tenant uuid)
returns table (upload_key text, created_with jsonb)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query
    select (select j.payload ->> 'key' from platform.job j
             where j.tenant_id = p_tenant and j.kind = 'import_apply' and j.status = 'done'
             order by j.finished_at desc nulls last limit 1),
           (select j.payload from platform.job j
             where j.tenant_id = p_tenant and j.kind = 'create_customer' and j.status = 'done'
             order by j.created_at desc limit 1);
end $$;
revoke execute on function platform.current_files(uuid) from public;
grant execute on function platform.current_files(uuid) to app_rw;

-- migrate:down
drop function platform.current_files(uuid);
