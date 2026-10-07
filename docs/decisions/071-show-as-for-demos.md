# 071 — Show as someone else, for demos

Status: accepted · 2026-10-07 · migration 20261127100000

A pitch shows the app through several people's eyes: the GM, the bar manager, the room
attendant, the store keeper. Signing in and out of a dozen logins on one phone, or carrying a
dozen phones, does not work in front of a GM. A demo presenter signs in once and switches.

## Decision

1. **Who.** A person in a **test customer** (`core.tenant.is_test`) marked `demo_presenter`
   (file 07's optional `demo_presenter` column, yes or no). A trigger refuses the flag in any
   other customer (`NOT_A_TEST_CUSTOMER`), and the loader refuses the column for one. Nothing
   of this exists for a real customer.

2. **As whom.** Anyone active and human in the presenter's own company, never themselves:
   `core.show_as_people()` lists them by outlet and department, with their job title.

3. **How it holds.** The database decides, not the screen.
   - `core.begin_show_as(person)`, called as the presenter, checks both and opens a row in
     `core.show_as_log` (one open row per presenter; a new one ends the last).
   - The server keeps a signed cookie naming presenter and person, which only counts in the
     presenter's own session; once per request it asks `core.showing_as(person)` as the
     presenter, and only then runs the request as that person.
   - Every transaction shown as someone calls `core.presented_by(presenter)` first, as that
     person: it refuses unless the presenter is still a presenter in the same test company
     with an open row for this person, and marks the transaction.
   - Taking the flag away, or the person leaving, stops it at the next request.

4. **What it leaves.** Everything done while shown as someone is theirs (it runs as them, with
   their access), and every audit row says who presented (`audit.log.presented_by`). Each
   start and stop is in `core.show_as_log`, audited.

5. **What it never touches: logins.** While shown as someone, changing a password, signing out
   everywhere, creating, linking or resetting a login and deactivating a person are refused
   (`PRESENTING`): in the database (triggers on `core.login_admin_event` and on the login
   columns of `core.app_user`) and in the server actions before Cognito is called.

6. **On screen.** Me shows "Show the app as someone" to a presenter. `/show-as` lists the people
   with a search. While shown as someone, a banner on every screen says so, with Switch and
   Back to (presenter).

## Why not

- **Several phones or logins**: slow and error-prone in a meeting; passwords on a sheet.
- **A platform admin "sign in as"**: the platform console lives outside every customer
  (ADR 012) and should stay that way; this needs no platform session in a customer's app.
- **Read-only previews**: the pitch is about doing things (receive, check a minibar, approve).
