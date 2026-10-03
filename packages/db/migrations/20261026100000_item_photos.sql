-- migrate:up
-- Item photos (UX-6, ADR 034): a picture of each item for stock lists, counts and prep.
--
-- An item's photo is set, changed or cleared only through inv.set_item_photo, by someone
-- who records stock changes (STOCK_ADJUSTMENTS modify) at a store that carries the item.
-- The photo lives in the private photo bucket under items/<tenant>/<item>/<uuid>.<ext>,
-- kept as long as the item (no lifecycle rule); the key names the company and the item,
-- so one company can never point at another's photo. inv.can_set_item_photo answers the
-- same question before the app signs an upload. The audit trigger on inv.item records
-- every change (rule 5).

alter table inv.item add column photo_key text,
  add constraint item_photo_key check (
    photo_key is null
    or photo_key ~ ('^items/' || tenant_id::text || '/' || id::text
                    || '/[0-9a-f-]{36}\.(jpg|png|webp)$'));

-- Whether the current user may set the item's photo: an item of their company, kept at a
-- store where they hold STOCK_ADJUSTMENTS modify.
create function inv.can_set_item_photo(p_item uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select exists (
    select 1
      from inv.item i
      join inv.item_node n on n.item_id = i.id and n.archived_at is null
     where i.id = p_item and i.tenant_id = core.my_tenant() and i.archived_at is null
       and core.can('STOCK_ADJUSTMENTS', 'modify', null, n.delivery_node_id));
$$;

revoke execute on function inv.can_set_item_photo(uuid) from public;
grant execute on function inv.can_set_item_photo(uuid) to app_rw;

-- Sets (or, with null, clears) the item's photo. The key must be this company's and this
-- item's; anything else is INVALID_PHOTO. Someone who may not is NOT_AUTHORISED, and so is
-- anyone asking about another company's item (as if it did not exist).
create function inv.set_item_photo(p_item uuid, p_photo_key text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_tenant uuid := core.my_tenant();
begin
  if not inv.can_set_item_photo(p_item) then
    perform inv.fail('NOT_AUTHORISED', 'item photo');
  end if;
  if p_photo_key is not null and p_photo_key !~ ('^items/' || v_tenant::text || '/'
       || p_item::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    perform inv.fail('INVALID_PHOTO', 'photo was not uploaded for this item');
  end if;
  update inv.item set photo_key = p_photo_key
   where id = p_item and tenant_id = v_tenant;
end $$;

revoke execute on function inv.set_item_photo(uuid, text) from public;
grant execute on function inv.set_item_photo(uuid, text) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function inv.set_item_photo(uuid, text);
drop function inv.can_set_item_photo(uuid);
alter table inv.item drop constraint item_photo_key, drop column photo_key;
