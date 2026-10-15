-- migrate:up

-- Place names in words (ADR 149). An outlet's stock place read "Test Solo Bar – Supply Point" in
-- Profile, the access audit and reports: a word nobody at an outlet uses. It is now "<outlet>
-- stores", as the onboarding files and the outlet templates now name it. A store's name holds
-- no note in brackets: Passport's "Housekeeping Store (with the in-room minibars)" read badly
-- inside sentences.
update core.hierarchy_node
   set name = regexp_replace(name, ' – Supply Point$', ' stores')
 where type = 'delivery' and name like '% – Supply Point';

update core.hierarchy_node
   set name = 'Housekeeping Store'
 where type = 'delivery' and name = 'Housekeeping Store (with the in-room minibars)';

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous names for local work.
update core.hierarchy_node
   set name = regexp_replace(name, ' stores$', ' – Supply Point')
 where type = 'delivery' and kind = 'outlet' and name like '% stores';
