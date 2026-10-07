-- migrate:up
-- File 42 (ADR 072): the onboarding loader marks a test customer's past minibar checks added
-- to the bill as the person the file names. The worker imports as platform_loader, which
-- 20261127110000_minibar left without this function, so the import failed on production.
-- The function still checks, as that person, that they may mark minibars charged.
grant execute on function ops.mark_minibar_charged(uuid) to platform_loader;

-- migrate:down
revoke execute on function ops.mark_minibar_charged(uuid) from platform_loader;
