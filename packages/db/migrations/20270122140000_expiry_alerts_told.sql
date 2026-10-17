-- migrate:up
-- The expiry alert (ADR 169): every 5 minutes it worked out every store's expiring stock and
-- the dishes that use it, before checking whether anyone still needed telling today. It now
-- skips a store with nothing that expires by tomorrow, with no team, or whose leads were all
-- told today, before that work.
select core.patch_function('ops.expiry_alerts(timestamptz)',
$x$inv.expiry_at(l.expires_at, coalesce(ops.tz_of(n.id), 'UTC')) > p_now)$x$,
$x$inv.expiry_at(l.expires_at, coalesce(ops.tz_of(n.id), 'UTC')) > p_now
                    and rpt.business_date(l.expires_at, coalesce(ops.tz_of(n.id), 'UTC'))
                        <= rpt.business_date(p_now, coalesce(ops.tz_of(n.id), 'UTC')) + 1)$x$);
select core.patch_function('ops.expiry_alerts(timestamptz)',
$x$    v_tz := coalesce(ops.tz_of(v_store.id), 'UTC');
$x$,
$x$    v_tz := coalesce(ops.tz_of(v_store.id), 'UTC');
    v_team := ops.team_of_store(v_store.id);
    v_link := '/stock/expiry?node=' || v_store.id;
    continue when v_team is null or not exists (
      select 1 from unnest(ops.leads(v_team)) u(id)
       where not exists (
         select 1 from ops.notification nt
          where nt.owner_user_id = u.id and nt.kind = 'expiry_soon' and nt.link = v_link
            and nt.created_at >= rpt.day_start(rpt.business_date(p_now, v_tz), v_tz)));
$x$);
select core.patch_function('ops.expiry_alerts(timestamptz)',
$x$    continue when v_count = 0;
    v_team := ops.team_of_store(v_store.id);
    continue when v_team is null;
    v_link := '/stock/expiry?node=' || v_store.id;
$x$,
$x$    continue when v_count = 0;
$x$);

-- migrate:down
select core.patch_function('ops.expiry_alerts(timestamptz)',
$x$inv.expiry_at(l.expires_at, coalesce(ops.tz_of(n.id), 'UTC')) > p_now
                    and rpt.business_date(l.expires_at, coalesce(ops.tz_of(n.id), 'UTC'))
                        <= rpt.business_date(p_now, coalesce(ops.tz_of(n.id), 'UTC')) + 1)$x$,
$x$inv.expiry_at(l.expires_at, coalesce(ops.tz_of(n.id), 'UTC')) > p_now)$x$);
select core.patch_function('ops.expiry_alerts(timestamptz)',
$x$    continue when v_count = 0;
$x$,
$x$    continue when v_count = 0;
    v_team := ops.team_of_store(v_store.id);
    continue when v_team is null;
    v_link := '/stock/expiry?node=' || v_store.id;
$x$);
select core.patch_function('ops.expiry_alerts(timestamptz)',
$x$    v_team := ops.team_of_store(v_store.id);
    v_link := '/stock/expiry?node=' || v_store.id;
    continue when v_team is null or not exists (
      select 1 from unnest(ops.leads(v_team)) u(id)
       where not exists (
         select 1 from ops.notification nt
          where nt.owner_user_id = u.id and nt.kind = 'expiry_soon' and nt.link = v_link
            and nt.created_at >= rpt.day_start(rpt.business_date(p_now, v_tz), v_tz)));
$x$,
$x$$x$);
