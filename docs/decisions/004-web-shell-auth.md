# 004 — Web shell, authentication and sessions

Status: accepted · 2026-09-29

This ADR records how the Next.js PWA shell (`apps/web`) authenticates users, keeps
sessions, reaches the database, and decides what to show.

## Data access

- **One path to Postgres.** All server code reaches the database only through
  `withUser(userId, fn)` in `apps/web/lib/db.ts` (CLAUDE.md AWS overrides). It runs as
  `app_rw`, and the module is `server-only`.
- **Pre-sign-in lookup.** The one exception is `userIdForCognitoSub`. It runs before a
  user is known and can only call `core.user_for_cognito_sub`.
- **Read functions** (migration `20260929150000_app_reads`). All are SECURITY DEFINER,
  executable by `app_rw`, and answer for `app.user_id` within the caller's tenant:

  | Function                                                        | Returns                                                                                       |
  | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
  | `core.me()`                                                     | the current active user                                                                       |
  | `core.my_domains()`                                             | domains with any grant (hierarchy, SELF, derived) and the strongest access                    |
  | `core.nodes(type)`                                              | nodes for the switcher, with derived delivery nodes flagged                                   |
  | `core.user_for_cognito_sub(sub)`                                | the user for a verified Cognito identity                                                      |
  | `wf.my_processes()`                                             | processes the user may initiate                                                               |
  | `core.admin_role_assignments()`, `core.admin_domain_policies()` | read-only admin lists; need `SECURITY_ROLES` view at the org root, otherwise `NOT_AUTHORISED` |

- **Nav is presentation only.** Bottom-nav items map to domains:
  - Stock → STOCK_LEVELS
  - Roster → ROSTER
  - Admin → SECURITY_ROLES

  An item shows only when `core.my_domains()` lists its domain. This decides what to show,
  not what is allowed: RLS and the RPCs enforce every read and write (rule 2).

- **Admin screens use the SECURITY_ROLES domain** and are read-only for the pilot.

## Pilot onboarding and admin edits

- **Days 20–21:** pilot users and role assignments are loaded by a migrator CSV script
  (users, `cognito_sub`, assignments), run by an operator.
- **Later:** edit screens come after `hr.worker` exists. They will submit `ROLE_CHANGE`
  requests, approved by SECURITY_ADMIN; the UI never edits role tables directly.

## Sessions

- **The cookie.** `oo_session` is httpOnly, SameSite=Lax, and Secure in production. It is
  HMAC-SHA256 signed with `SESSION_SECRET` (Web Crypto, at least 32 characters). It carries
  only `{uid, src, iat, seen, ref}`.
- **Re-checked every request.** Every request still re-reads the user through
  `core.me()`, so a deactivated user is signed out at once.
- **Timeouts:**
  - Idle timeout is 12 h. `seen` slides, and the proxy re-issues the cookie at most every
    5 minutes.
  - Absolute timeout is 30 days from sign-in, and is also the cookie max-age.
- **`proxy.ts`** (Next 16's renamed middleware) makes the optimistic check and the
  redirect to `/login`. The data layer makes the real check.

## Cognito

- **Sign-in flow:** Hosted UI, authorization code flow with PKCE, public app client (no
  secret).
  - `/auth/login` sets a 10-minute `oo_pkce` cookie holding the state and verifier.
  - `/auth/callback` checks the state, exchanges the code, and verifies the ID token with
    `aws-jwt-verify` (signature, issuer, audience, `token_use`, expiry).
  - It then maps `sub` to a user with `core.user_for_cognito_sub`.
- **Server-side refresh rotation.**
  - The refresh token lives only in the httpOnly `oo_refresh` cookie.
  - Hourly, the proxy exchanges it at `/oauth2/token` and re-verifies the new ID token.
  - When the app client has refresh-token rotation enabled, it stores the new refresh
    token Cognito returns.
  - If the refresh fails, the user is signed out.
- **Configuration:** `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`,
  `APP_URL`. When they're unset, Cognito sign-in is off.
- **India SMS OTP.** SMS to Indian numbers requires DLT registration of the sender ID and
  message templates, and that takes time. Plan a pilot fallback: email OTP, or
  username and password. The choice is confirmed in the infra prompt, together with the
  user pool setup (phone OTP, rotation, domain, callback and logout URLs).

## Sign-out

1. The sign-out button deletes every Cache Storage entry, which removes the service
   worker's caches.
2. It then calls `POST /auth/logout`, which:
   - revokes the Cognito refresh token (`/oauth2/revoke`)
   - clears the `oo_session`, `oo_refresh`, `oo_node` and `oo_pkce` cookies
   - sends `Clear-Site-Data: "cache"`
3. Cognito users are then sent to the Hosted UI `/logout`, which ends the Cognito session;
   everyone else goes to `/login`.

An e2e test checks that the cookies and caches are gone and protected pages redirect.

## Dev-only login and test request form

- **Scope.** `/dev-login` lets you pick any seeded user. The user list is a constant,
  `DEV_USERS`, which a DB test keeps in step with the seed, so the web app never needs a
  privileged DB connection. `/requests/new`, the test request form, sits behind the same
  gate and is marked for removal in the inventory prompt.
- **The gate.** Both are enabled only when `NODE_ENV !== 'production'` and
  `DEV_AUTH_STUB === 'true'`. Next inlines `NODE_ENV` at build time, so a production build
  cannot enable them, whatever the runtime environment says. Both the pages and the server
  actions return 404.
- **Build guard.** `next.config.ts` refuses a production build with `DEV_AUTH_STUB=true`.
- **Proof in CI.** `scripts/check-prod-dev-auth.sh` checks three things:
  - the refused build
  - that the standalone server (the artifact the release bundle ships, ADR 005) started
    with `DEV_AUTH_STUB=true` returns 404 for `/dev-login` and `/requests/new`, even
    with a valid session
  - that the login page has no dev link
- **E2E on the shipped artifact.** Playwright's `prod` project runs against the same
  standalone server. Since dev login is compiled out there, tests sign in with a session
  cookie signed with the server's `SESSION_SECRET` and submit requests through
  `wf.submit` as that user (`apps/web/e2e/helpers.ts`); nothing test-only is added to the
  app. A small `dev` project covers the dev-only pages against `next dev`.

## UI conventions

- **Errors.** DB errors surface as stable codes, mapped to messages in
  `packages/domain/src/errors.ts`. SQLSTATE 42501 (RLS or grant refused) maps to
  `NOT_AUTHORISED`, and anything else shows a generic message and is logged server-side.
  Server actions return `ActionResult`.
- **Polling.** The 30 s polling comes from `usePolling()`, which calls
  `router.refresh()`. It pauses while the tab is hidden and refreshes on return; the timer
  logic lives in `lib/poller.ts` and is unit-tested.
- **PWA.**
  - The manifest has 192/512 PNG icons and a maskable icon, rendered with `ImageResponse`.
  - `public/sw.js` precaches only `/offline` and serves it when a navigation fails. It
    never caches authenticated pages.
- **Layout.** Mobile-first at 380 px: a sticky header with the node switcher and sign-out,
  a bottom nav with 56 px targets, and 48 px buttons.

## Seed changes

- **STORE_KEEPER gets AI_RECOMMENDATIONS view.** That domain is in the org tree, but the
  store keeper was assigned only in the delivery tree, where org-tree policies never
  apply. The store keeper therefore also holds STORE_KEEPER at org Outlet A, following the
  outlet-manager pattern. That assignment activates only org-tree policies, which today
  means AI_RECOMMENDATIONS view.
- **Tenant triggers.** Same-tenant triggers now also cover `core.bp_policy` (group) and
  `core.hierarchy_node` (parent) (migration `20260929140000_tenant_consistency_more`).
