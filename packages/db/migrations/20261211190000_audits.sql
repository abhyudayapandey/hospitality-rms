-- migrate:up
-- Audits & taste panels (ADR 095), the Audits block (ADR 085, domain AUDITS; it needs
-- Checklists).
--
-- * Two scored step kinds: `yesno` (yes, no or not applicable) and `rating` (1 to 5). A
--   checklist of them is an audit (a service audit, the management taste panel): it runs on its
--   schedule like any checklist round, but belongs to the Audits block (`module = 'audits'`), so
--   it has no rounds while Audits is off.
-- * Its score: each answered step counts yes = 1, no = 0, a rating of n = n / 5; not applicable
--   is left out. The score is the mean, as a %, of a done round (ops.task_score).
-- * The Audits screen: each audit at a place with its last rounds' scores, for whoever holds
--   AUDITS there (supervisors read; department heads and the outlet's managers).

alter table ops.task_step drop constraint task_step_kind_check;
alter table ops.task_step add constraint task_step_kind_check
  check (kind in ('tick', 'number', 'text', 'photo', 'discard', 'batch', 'receive', 'yesno',
                  'rating'));

do $$
declare
  v_src text := pg_get_functiondef('ops.check_steps(jsonb)'::regprocedure);
  v_new text;
begin
  v_new := replace(replace(v_src,
    $x$not in ('tick', 'number', 'text', 'photo') then$x$,
    $x$not in ('tick', 'number', 'text', 'photo', 'yesno', 'rating') then$x$),
    $x$'tick, number, text or photo'$x$,
    $x$'tick, number, text, photo, yes or no, or a rating'$x$);
  if v_new = v_src or strpos(v_new, '''yesno''') = 0 then
    raise exception 'ops.check_steps: the parts to change are not there';
  end if;
  execute v_new;
end $$;

select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$    when 'text' then
      if v_text is null then
        perform ops.fail('INVALID_VALUE', 'some text');
      end if;$x$,
$x$    when 'text' then
      if v_text is null then
        perform ops.fail('INVALID_VALUE', 'some text');
      end if;
    when 'yesno' then
      v_text := p_value ->> 'answer';
      if v_text is null or v_text not in ('yes', 'no', 'na') then
        perform ops.fail('INVALID_VALUE', 'yes, no or not applicable');
      end if;
    when 'rating' then
      begin
        v_num := (p_value ->> 'number')::numeric;
      exception when invalid_text_representation then
        perform ops.fail('INVALID_VALUE', '1 to 5');
      end;
      if v_num is null or v_num not in (1, 2, 3, 4, 5) then
        perform ops.fail('INVALID_VALUE', '1 to 5');
      end if;$x$);

-- A round's score, 0 to 100, or null when nothing scored was answered.
create function ops.task_score(p_task uuid) returns numeric
language sql stable security definer
set search_path = pg_catalog, ops
as $$
  select round(100 * avg(case when s.kind = 'yesno' and s.value_text = 'yes' then 1
                              when s.kind = 'yesno' and s.value_text = 'no' then 0
                              when s.kind = 'rating' then s.value_num / 5 end), 1)
    from ops.task_step s
   where s.task_id = p_task and s.kind in ('yesno', 'rating') and s.done_at is not null
     and not (s.kind = 'yesno' and s.value_text = 'na');
$$;

-- The places whose audits I see.
create function ops.audit_places()
returns table (place_id uuid, name text, audits int)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select n.id, n.name, count(c.id)::int
    from core.hierarchy_node n
    join ops.checklist_template c on c.org_node_id = n.id and c.archived_at is null
                                 and c.module = 'audits'
   where n.tenant_id = core.my_tenant() and n.archived_at is null
     and core.can('AUDITS', 'view', n.id, null)
   group by n.id, n.name
   order by n.name;
$$;

-- A place's audits and their done rounds of the last p_days days, newest first, with scores.
create function ops.audit_rounds(p_place uuid, p_days int default 180)
returns table (template_id uuid, audit text, task_id uuid, done_at timestamptz, done_by text,
               score numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
#variable_conflict use_column
begin
  if not core.can('AUDITS', 'view', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'AUDITS view');
  end if;
  return query
    select c.id, c.name, t.id, t.completed_at,
           (select u.display_name from core.app_user u where u.id = t.completed_by),
           ops.task_score(t.id)
      from ops.checklist_template c
      left join ops.task t on t.template_id = c.id and t.status = 'done'
                          and t.completed_at > now() - make_interval(days => p_days)
     where c.org_node_id = p_place and c.module = 'audits' and c.archived_at is null
       and c.tenant_id = core.my_tenant()
     order by c.name, t.completed_at desc nulls last;
end $$;

revoke execute on function ops.task_score(uuid), ops.audit_places(), ops.audit_rounds(uuid, int)
  from public, platform_loader;
grant execute on function ops.task_score(uuid), ops.audit_places(), ops.audit_rounds(uuid, int)
  to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.audit_rounds(uuid, int);
drop function ops.audit_places();
drop function ops.task_score(uuid);
do $$
begin
  execute regexp_replace(pg_get_functiondef('ops.complete_step(uuid, uuid, jsonb)'::regprocedure),
    E'    when ''yesno'' then.*?(    else\\n)', E'\\1', 's');
  execute replace(replace(pg_get_functiondef('ops.check_steps(jsonb)'::regprocedure),
    $x$not in ('tick', 'number', 'text', 'photo', 'yesno', 'rating') then$x$,
    $x$not in ('tick', 'number', 'text', 'photo') then$x$),
    $x$'tick, number, text, photo, yes or no, or a rating'$x$,
    $x$'tick, number, text or photo'$x$);
end $$;
alter table ops.task_step drop constraint task_step_kind_check;
alter table ops.task_step add constraint task_step_kind_check
  check (kind in ('tick', 'number', 'text', 'photo', 'discard', 'batch', 'receive'));
