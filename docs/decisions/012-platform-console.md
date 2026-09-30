# 012 — Platform Admin console (B1)

Status: accepted · 2026-10-05

PRD section 8 (ADM-1..4) asks for a console where platform admins create customers and
their first account owner, see customer status and suspend or reactivate them, with a
separate login and authenticator-app MFA. B1 ships sign-in, the customer list, creating a
customer and suspend/reactivate; B2 adds imports and logins.

- **Migration:** `20261005100000_platform` (forward-only).
- **Deploy:** new secret, then the stack, then the Deploy workflow; see `docs/deploy.md`.

## Platform admins live outside every customer

- `platform.admin` has no `tenant_id`. A platform request runs in `withPlatformAdmin()`,
  which sets `app.platform_admin_id` and clears `app.user_id`.
  `core.current_user_id()` returns null whenever `app.platform_admin_id` is set, so
  `core.can()` and every RLS policy deny, even if code also sets `app.user_id`. A test
  reads stock, rosters, workers (and their pay), requests and the access audit in a
  platform session with a customer user id set too, and gets nothing.
- Platform functions (`platform.customers`, `suspend`, `reactivate`,
  `request_create_customer`, `jobs`, `audit`, `link_owner_login`) need an active
  platform admin session, return customer metadata only and write `platform.audit_event`.
  A customer user, even an account owner, gets `NOT_AUTHORISED` from each.
- `platform.audit_event` is append-only: `app_rw` has no grants on the platform tables,
  and a trigger refuses update, delete and truncate even for the owner.

## Sign-in: a separate pool, and only the platform-admins group

- A second Cognito pool, `PlatformUsers`: self sign-up disabled (a CDK test fails if it
  is ever enabled), MFA required with an authenticator app only (no SMS), passwords of
  at least 14 characters with every character class, deletion protection, retained on
  delete. Its own client (callback `/platform/auth/callback`) and domain prefix.
- A `platform.admin` row is created on first sign-in **only** when the verified ID token
  of that pool lists `platform-admins` in `cognito:groups`. Anyone else who signs in to
  the pool is refused. The group is created by the stack; the one-time setup adds the
  first admin to it (`docs/deploy.md`).
- The platform session is its own cookie (`oo_platform`), limited to `/platform`,
  `SameSite=Strict`, 30 minutes idle and 8 hours absolute, signed with a key derived only
  for the platform: a customer token never verifies as a platform one, nor the other way
  round.
- Because the cookie is `SameSite=Strict`, the callback does not redirect straight to
  `/platform`. The return from the hosted UI is a navigation started on Cognito's site,
  and the browser withholds a Strict cookie on every hop of it, redirects included (the
  first production sign-in landed on `signin?reason=invalid`). The callback ends at
  `/platform/auth/continue`, a page on our site that moves on to `/platform`; that
  navigation starts here, so the cookie is sent. An e2e test drives a stand-in hosted UI
  on another site to prove both halves.
- The proxy keeps the two worlds apart: `/platform` accepts only a platform session (a
  customer session is sent to the platform sign-in), and the platform cookie is never sent
  outside `/platform`, so a platform session opens nothing in the app.
- The app instance has no IAM rights on the platform pool.

## Suspending a customer is enforced in SQL

- `core.tenant.status` is `active` or `suspended`. `core.me()`, `wf.me()`,
  `core.user_for_cognito_sub` and `core.user_for_username` return nothing for a suspended
  customer, so every session ends on its next request and nobody can sign in. Cognito
  logins stay enabled, so reactivating is one step. Both actions need a reason and are
  in the platform audit.

## Test customers: is_test is fixed at creation

- `core.tenant.is_test` is set when a customer is created (the console's checkbox, or
  `is_test` in file 00) and a trigger refuses any later change (`IS_TEST_IMMUTABLE`); the
  audit trigger records it. Only test customers may use the `Test<Role>!12` password rule
  (PRD ADM-1); the loader refuses `test_rule` for anyone else. The two test customers are
  flagged as test.

## The worker runs as platform_loader, never migrator

- Creating a customer is a `platform.job`. The web app queues it; the
  `outlet-ops-platform-worker` service claims jobs (`FOR UPDATE SKIP LOCKED`) and runs them.
  The web page polls every 2 s.
- The worker's only credential is `platform_loader`: a role with DML on the customer
  schemas and `BYPASSRLS` (the loader writes across customers, as it did as `migrator`),
  but no DDL rights. It owns nothing, cannot create, alter, drop or truncate anything
  (tests), and is never granted to `migrator` in production. Its own OS user, its own
  systemd unit and `LoadCredential`; no other unit or the web environment sees it. It is
  created by `bootstrap-db.sh` from its own SSM secret before migrations run.
  - On a future move to RDS (ADR 005), `BYPASSRLS` needs the RDS master user; to be
    checked then.
- `createCustomer()` runs the onboarding loader on a minimal bundle: the customer, its
  company root, the `ACCOUNT_OWNER` job role (`ACCOUNT_OWNER@whole_company`) and the owner
  (`<code>.owner`, email login). The loader also syncs product access and workflow
  definitions and creates the AI agent. A later full import upserts onto the same codes.
  Running it twice changes nothing.
- When the job is done, the console sends the owner Cognito's email invitation (they set
  their own password) and records the login (`platform.link_owner_login`).

## Customer list

ADM-4: status, test flag, active people and last activity. Last activity is the latest
sign-in (`core.app_user.last_sign_in_at`); the audit log has no per-customer index to read
the latest change cheaply.
