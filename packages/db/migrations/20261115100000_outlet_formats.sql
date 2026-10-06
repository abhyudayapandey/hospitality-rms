-- migrate:up
-- Outlet formats follow the SOP manuals (ADR 062): restaurant, bar_pub, qsr, cloud_kitchen
-- and hotel. standalone_bar becomes bar_pub; full_hotel and small_hotel become hotel (a
-- small hotel is the hotel format with fewer departments). The onboarding loader still
-- reads the old codes, as the new ones.
--
-- Nobody's access may change. A job role whose grants differ by hotel size would merge two
-- sets of grants into one, so the migration refuses while any role has full_hotel or
-- small_hotel rows (none do: only the Bar Manager and the solo bar's Stock Verifier have
-- format rows, both standalone_bar). Role assignments keep their source note in step.

do $$
begin
  if exists (select 1 from hr.job_role_access
              where outlet_format in ('full_hotel', 'small_hotel')) then
    raise exception 'FORMAT_MERGE'
      using detail = 'a job role has grants for full_hotel or small_hotel; give them as '
                     'any (or hotel) in file 06 before this migration';
  end if;
end $$;

alter table core.hierarchy_node drop constraint hierarchy_node_outlet_format_check;
alter table hr.job_role_access drop constraint job_role_access_outlet_format_check;

update core.hierarchy_node
   set outlet_format = case outlet_format when 'standalone_bar' then 'bar_pub' else 'hotel' end
 where outlet_format in ('standalone_bar', 'full_hotel', 'small_hotel');
update hr.job_role_access set outlet_format = 'bar_pub' where outlet_format = 'standalone_bar';
update core.role_assignment
   set source_note = replace(source_note, '(standalone_bar)', '(bar_pub)')
 where source_note like '%(standalone_bar)%';

alter table core.hierarchy_node add constraint hierarchy_node_outlet_format_check
  check (outlet_format in ('restaurant', 'bar_pub', 'qsr', 'cloud_kitchen', 'hotel'));
alter table hr.job_role_access add constraint job_role_access_outlet_format_check
  check (outlet_format in ('any', 'restaurant', 'bar_pub', 'qsr', 'cloud_kitchen', 'hotel'));

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work
-- (every hotel back to full_hotel; the new formats have no old code).
alter table core.hierarchy_node drop constraint hierarchy_node_outlet_format_check;
alter table hr.job_role_access drop constraint job_role_access_outlet_format_check;
update core.hierarchy_node
   set outlet_format = case outlet_format when 'bar_pub' then 'standalone_bar'
                                          when 'hotel' then 'full_hotel' end
 where outlet_format is not null;
update hr.job_role_access
   set outlet_format = case outlet_format when 'bar_pub' then 'standalone_bar'
                                          when 'hotel' then 'full_hotel' end
 where outlet_format <> 'any';
update core.role_assignment
   set source_note = replace(source_note, '(bar_pub)', '(standalone_bar)')
 where source_note like '%(bar_pub)%';
alter table core.hierarchy_node add constraint hierarchy_node_outlet_format_check
  check (outlet_format in ('full_hotel', 'small_hotel', 'standalone_bar'));
alter table hr.job_role_access add constraint job_role_access_outlet_format_check
  check (outlet_format in ('any', 'full_hotel', 'small_hotel', 'standalone_bar'));
