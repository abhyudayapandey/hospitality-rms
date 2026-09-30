# 011 — User administration in the app

Status: accepted · 2026-10-04

PRD section 8 (USR-1..4) asks for in-app user administration: add people with a derived-access
preview, extra and cover access with dates, password resets, deactivating leavers, and an
access audit. ADR 009 built the guarded SQL (`grant_access`, `create_user`,
`set_user_status`, `access_audit`); this ADR adds the screens and their Cognito side.

- **Migration:** `20261004100000_user_admin` (forward-only).
- **Deploy:** a CDK change (instance role) first, then the Deploy workflow; see
  `docs/deploy.md`.

## Database first, then Cognito

- Every screen action calls one `core.*` SECURITY DEFINER function. It checks scope, rank
  and self-changes (`core.check_admin_action`) and writes the audit row. Only then does the
  server call Cognito.
- Each Cognito step can be retried: creating a login that exists finds it; disable, enable
  and sign-out are idempotent.
- **Deactivating** runs in this order: `core.set_user_status` (the person is cut off at
  once: `core.me()` returns nothing for them, so their next request signs them out), then
  `AdminDisableUser`, then `AdminUserGlobalSignOut`. A Cognito failure leaves them already
  cut off, and the button can be pressed again.
- **Previews cannot drift.** `core.preview_create_user` runs `core.create_user` in a
  subtransaction and rolls it back, returning each derived row as `now`, `approval`
  (ROLE_CHANGE) or `sole owner: now`. `core.preview_grant` labels one grant the same way.
- **Edits** (`core.update_user`) change name, email, job role or home place and re-derive
  job-role access. New sensitive defaults and the end of sensitive ones go through
  ROLE_CHANGE; extra access is left alone.
- **Login actions** (`core.login_admin_target`) check the target and write a
  `core.login_admin_event` (password reset, login disabled or enabled), shown in the access
  audit. Password resets are for username logins only.

## Logins are unique across customers

- There is one Cognito pool for all customers, and its usernames and email aliases are
  pool-wide. The database now enforces the same: unique indexes on `lower(username)` and
  `lower(email)` for human users (service users such as `ai-agent` never sign in).
- `create_user`, `update_user` and the loader report `USERNAME_TAKEN` / `EMAIL_TAKEN`; the
  loader gives file, row and column.
- Suggestions are prefixed with the customer code: `core.suggest_username('Ravi Kumar')`
  gives `acme.ravi.k`, then `acme.ravi.k2` when taken anywhere. The loader suggests
  `acme.<username>` for a clash.

## Temporary passwords

- Generated with the crypto RNG (unbiased, 14 characters, digits and both cases, no
  look-alike characters), set with `AdminCreateUser` or `AdminSetUserPassword`
  (`Permanent: false`), returned once in the action's response and never stored or
  logged. The download is a browser Blob made from that response.
- Email logins sign in with a one-time code and get no password; Cognito sends no
  invitation (`MessageAction: SUPPRESS`).

## Request safety

- **CSRF.** Every admin server action calls `requireSameOrigin()`: `Origin` must equal
  `APP_URL`, and `Sec-Fetch-Site` must be `same-origin` when present. This sits behind
  Next.js's own server-action origin check; e2e replays a real action with a forged
  origin and checks nothing changed.
- **Rate limits** are counters in Postgres (`core.rate_limit_hit`, fixed windows), so they
  survive restarts. They cover sign-in starts and callbacks per client address, and
  password resets per admin. Wrong passwords typed on the Cognito page never reach the
  app; Cognito's lockout covers those. `core.rate_limit` is the one core table without
  the audit trigger: it holds only counters.
- **Least privilege.** The instance role gets exactly `AdminCreateUser`, `AdminGetUser`,
  `AdminSetUserPassword`, `AdminDisableUser`, `AdminEnableUser`, `AdminUserGlobalSignOut`
  and `AdminUpdateUserAttributes`, on the customer pool ARN only; a CDK test fails on any
  other Cognito action or resource. The SDK dependency
  (`@aws-sdk/client-cognito-identity-provider`) is needed because the admin API is not
  reachable through the hosted UI.
- Without Cognito configured (dev, e2e), a no-op directory stands in; the database side
  is what the tests check.

## Screens

`/admin` (hub, each section shown only when the database allows it), `/admin/users`,
`/admin/users/new`, `/admin/users/[id]` and `/admin/audit`. The Admin nav item follows
`USER_ACCESS` as well as `SECURITY_ROLES`. Sign-ins record `last_sign_in_at`, shown in the
list.
