# 166. Security fixes from the platform review

Date: 2026-10-17. Status: accepted. Migrations `20270119100000_security_review`,
`20270119110000_create_login_checked`, `20270119120000_money_gates`,
`20270119130000_new_demo_passwords`.

## Context

The platform review found these, each checked again against the code:

- **C1.** `inv.transfer_summary` was made `security_invoker`, then re-created by a plain
  `CREATE OR REPLACE VIEW` (20261102100000_po5_rfm), which drops the option. It ran as its
  owner, so RLS on `inv.transfer` was skipped: a Test Solo Bar Co. person read Test Company's
  transfers. No test looked at views.
- **H1.** The guard tests read tables only, a few as another company, and nothing checked
  which SECURITY DEFINER functions anyone (PUBLIC) could run. Nine could.
- **C2.** "Set up login again" found the person with `core.admin_user` (USER_ACCESS view).
  When the login already existed, Cognito got a new temporary password before
  `core.link_login` refused a view-only admin: anyone with view rights on people could lock
  out, or take over, anyone, the owner too. No rank check, audit or limit. The console's
  username logins went through the same branch (L8).
- **H2, M10.** The adjustment page showed ₹ to anyone with STOCK_ADJUSTMENTS view (a chef de
  partie); an order's approval reason "Worth ₹X, above ₹Y" reached every PURCHASE_ORDERS
  viewer.
- **H3.** next 16.3.6 had high advisories; postcss's source-map-js too.
- **M4, L11.** `backHref` let `/\t/evil.example` through (browsers drop tab, CR and LF, so it
  is `//evil.example`); push links took `//host`.
- **M5.** The repository is public and its docs gave the demo companies' production
  passwords (one guessable rule for every login), the Passport presenter's included.
- **L3.** Sign-out had no same-origin check.

## Decision

1. **Views run as the caller.** `inv.transfer_summary` is `security_invoker` again. Every view
   the app can read is `security_invoker`, or on an allow-list with its reason
   (`hr.worker_directory`: names and roles for pickers, filtered by the caller's company and
   ROSTER places itself). `security-guards.db.test.ts` checks it, and shows that re-creating a
   view with `CREATE OR REPLACE` is caught.
2. **Every relation, both ways.** The same test reads every table and view `app_rw` can select
   as a Solo manager (no Test Company row), as Test Company's owner (no Solo row), with no
   person and as a platform admin (no customer row). A relation without `tenant_id` must say
   how to find each row's company.
3. **No SECURITY DEFINER function for PUBLIC.** The nine lose PUBLIC; `app_rw`, `wf_executor`
   and `platform_loader` keep what they call. `alter default privileges for role migrator
revoke execute on functions from public`: a new function is callable only by the roles a
   migration grants it to (every migration already revokes PUBLIC and grants `app_rw`).
4. **"Set up login again" is a checked reset.** The app calls
   `core.login_admin_target(person, 'create_login')` first (USER_ACCESS modify, scope, rank,
   self, an audit row "Sign-in set up"), under the password-reset rate limit, before any
   Cognito call. The directory never sets a password on a login that already exists; it says
   it existed. The caller links it to the person first (`core.link_login`,
   `platform.link_customer_login`: refused when it is someone else's), and only then sets the
   new one-time password.
5. **Money in SQL.** `inv.sees_adjustment_money(adjustment)`: the store's money readers
   (`inv.sees_store_money`) and whoever may approve it now; the page reads amount and unit
   costs as null otherwise and shows no ₹. `inv.po_approval`'s reason keeps "Worth ₹X" for the
   approver and the order's money readers; others read "Over the amount that needs approval".
   The stock list and item movements no longer read costs they never showed.
6. **Dependencies.** next ~16.3.8; `source-map-js >=1.2.2` as a pnpm override; CI's static job
   runs `pnpm audit --prod --audit-level high`.
7. **Paths inside the app.** `isAppPath` (`lib/back.ts`): one leading slash, no second slash or
   backslash, no control characters (also once decoded), and the same origin when parsed.
   Push links (`appLink`, push.ts and sw.js): `^/(?![/\\])`, no control characters.
8. **No pattern passwords.** Test customers' logins get random one-time passwords on the
   printed sheet like everyone's; `platform.begin_logins` refuses the old option for every
   customer. A test customer's Logins page has **New passwords for all**
   (`platform.begin_new_passwords`): every linked username login gets a new one-time password
   and is signed out, in the app and in Cognito. No committed document may hold the old
   passwords or their rule (`no-passwords-in-docs.test.ts`).
9. **Sign-out** checks the origin like the platform's.

## Consequences

- Access changed (grants, revokes, a view's RLS): the "RLS equivalence (all users)" workflow
  must run before merging.
- A migration that adds a function must grant it to the roles that call it; PUBLIC no longer
  gets it by default.
- The demo companies' old passwords keep working in production until a platform admin uses
  **New passwords for all** on each one (Passport, [TEST] Restaurant, Test Company, Test Solo
  Bar Co.).
