-- migrate:up
-- Checklists copied from the starter library (ADR 062) remember which library checklist and
-- version they came from, so a newer library version can later be offered to the outlet's
-- manager and admins. The outlet owns its copy: nothing here changes a checklist.
alter table ops.checklist_template
  add column library_code text check (library_code ~ '^[A-Z][A-Z0-9-]*$'),
  add column library_version int check (library_version > 0),
  add constraint checklist_template_library check ((library_code is null) = (library_version is null));

-- migrate:down
alter table ops.checklist_template
  drop constraint checklist_template_library,
  drop column library_version,
  drop column library_code;
