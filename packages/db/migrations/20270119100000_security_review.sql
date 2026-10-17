-- migrate:up
-- Security fixes from the review (ADR 166).

-- C1: the transfer summary lost security_invoker when 20261102100000_po5_rfm re-created it
-- with CREATE OR REPLACE VIEW, so it ran as its owner and showed every customer's transfers
-- to anyone signed in. It runs as the caller again: inv.transfer's RLS applies.
alter view inv.transfer_summary set (security_invoker = true);

-- L13: no SECURITY DEFINER function is open to PUBLIC. These nine were; the roles that call
-- them keep them (each already held its own grant, node_name now for wf_executor too).
revoke execute on function
  core.can(text, text, uuid, uuid, uuid), core.org_root(uuid), core.my_tenant(),
  core.can_any(text, text), core.node_name(uuid), core.visible_nodes(text, text),
  core.visible_domain_nodes(text), platform.account_owners(uuid),
  platform.remove_account_owner(uuid, uuid, text)
  from public;
grant execute on function
  core.can(text, text, uuid, uuid, uuid), core.org_root(uuid), core.my_tenant(),
  core.can_any(text, text), core.node_name(uuid), core.visible_nodes(text, text),
  core.visible_domain_nodes(text)
  to app_rw, wf_executor, platform_loader;
grant execute on function
  platform.account_owners(uuid), platform.remove_account_owner(uuid, uuid, text)
  to app_rw;

-- ...and a function made from now on is not either: each migration grants it to the roles
-- that call it (security-guards.db.test.ts).
alter default privileges for role migrator revoke execute on functions from public;

-- migrate:down
alter default privileges for role migrator grant execute on functions to public;
grant execute on function
  core.can(text, text, uuid, uuid, uuid), core.org_root(uuid), core.my_tenant(),
  core.can_any(text, text), core.node_name(uuid), core.visible_nodes(text, text),
  core.visible_domain_nodes(text), platform.account_owners(uuid),
  platform.remove_account_owner(uuid, uuid, text)
  to public;
revoke execute on function core.node_name(uuid) from wf_executor;
alter view inv.transfer_summary reset (security_invoker);
