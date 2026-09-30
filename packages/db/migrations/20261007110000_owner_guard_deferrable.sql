-- migrate:up
-- The "at least one active Account Owner" guardrail (admin_guardrails) becomes a constraint
-- trigger: still checked at once by default (every app path is unchanged), but the
-- onboarding loader may defer it while it re-derives access from job roles and file 08
-- (ADR 013 addendum). An owner whose ACCOUNT_OWNER moves from their job role to extra
-- access (Test Solo Bar Co's bar manager) is then never counted as missing half-way. The
-- loader checks it again before it goes on, so a dry run reports the same as the apply.

drop trigger last_account_owner on core.role_assignment;
drop trigger last_account_owner on core.app_user;
create constraint trigger last_account_owner after update or delete on core.role_assignment
  deferrable initially immediate
  for each row execute function core.guard_account_owner();
create constraint trigger last_account_owner after update of status on core.app_user
  deferrable initially immediate
  for each row execute function core.guard_account_owner();

-- migrate:down
drop trigger last_account_owner on core.role_assignment;
drop trigger last_account_owner on core.app_user;
create trigger last_account_owner after update or delete on core.role_assignment
  for each row execute function core.guard_account_owner();
create trigger last_account_owner after update of status on core.app_user
  for each row execute function core.guard_account_owner();
