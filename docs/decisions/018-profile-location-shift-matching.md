# 018 — Profile, outlet location, and matching punches to shifts (Prompt 11a)

Status: accepted · 2026-10-02

Three follow-ups people asked for: a profile screen, setting an outlet's location from
the app, and My shifts / Clock that show how each punch matched the roster.

- **Migration** (forward-only): `20261013100000_profile_location_timeline`.
- **Deploy:** no stack change, no new parameter. Run the Deploy workflow. No re-import is
  needed (`docs/deploy.md`).

## Profile

Tapping your name in the header opens **/profile**.

- **Your details, read-only.** Name, username or email, job role, home place and sign-in
  method (`core.my_profile`). Name and email changes stay with an admin.
- **Your access in plain words.** `core.my_access` returns your own active grants, plus
  self-service, with the domains each gives. `@outlet-ops/domain` turns domains into words
  ("Change: rosters, attendance. See: people"); a test fails if a domain has no words.
- Neither function takes a user, so nobody can read someone else's profile through them.

### Changing your own password (username logins only)

- **How.** The server signs in with your username and current password
  (`USER_PASSWORD_AUTH`), then calls Cognito `ChangePassword` with that session's access
  token. Cognito applies the pool's policy: at least 10 characters, a digit and a
  lower-case letter. The form checks the same rule first, for early feedback.
- **No stack change.** The Web client already allows `USER_PASSWORD_AUTH`
  (`authFlows.user`). `ChangePassword` is a call made as the person, so the instance role
  needs nothing new.
- **Rate limit.** 5 attempts an hour per person (`pwchange:<user>`, `core.rate_limit_hit`).
  Mismatched or too-weak new passwords are refused before they count.
- **Audit.** Every attempt that reaches Cognito is recorded in `core.login_admin_event`, as
  "password changed" or "password change failed". The access audit shows both. Passwords
  are never stored or logged.
- **Email-code logins** have no password: the form is hidden, and
  `core.record_own_password_change` refuses them (`INVALID_ACTION`).
- **Dev and e2e** use the no-op directory, which accepts any change.

### Sign out of all devices

1. `core.sign_out_everywhere` sets `core.app_user.sessions_valid_from` to now and records
   "signed out of all devices".
2. The server calls Cognito `AdminUserGlobalSignOut`, which the instance role already
   allows. This revokes every refresh token.
3. This device's cookies are cleared, and it goes to the sign-in page.

- **Every other device is out on its next request, not at its next hourly refresh.**
  `currentUser()` refuses a session cookie issued before `sessions_valid_from`
  (`issuedBeforeSignOut`). The cookie's `iat` is in whole seconds, so a sign-in in the same
  second counts as after.
- **If Cognito fails, the app sessions are already ended.** The failure is logged.

## Outlet location set in the app

**/settings/location** sets the same `hr.node_setting` row that file 04 writes: latitude,
longitude and clock-in radius.

- **Who.**
  - ATTENDANCE modify at the place itself: the GM and AGM (OUTLET_MANAGER).
  - COMPANY_SETTINGS modify: the Account Owner.
  - A department head's ATTENDANCE modify is on their department, so it doesn't reach
    the outlet.
- **Where.** Outlets and sites only (`INVALID_PLACE` otherwise). The radius is 10 to
  5000 m (`INVALID_RADIUS`); file 04 now has the same range (it allowed 1 m before).
- **How.** "Use my current location" takes a fresh fix and shows its accuracy. It warns
  above 100 m. A link opens OpenStreetMap at the point so the pin can be checked by eye.
- **When it applies.** `hr.clock` reads the row on every punch, so the next clock-in uses
  it. The audit trigger records each change.

### File 04 still works, and warns first

The row remembers who set it in the app and when (`set_in_app_by`, `set_in_app_at`).

- **A re-import of file 04 still upserts the row.** It also clears those two columns: the
  file is the source again.
- **The dry run warns first.** When the file's values differ from a location set in the
  app, the warning names who changed it and when, then gives both values:

  > TEST-HOTEL-1.0: the location was set in the app by Test General Manager 1.0 on 02 Oct
  > 2026 14:05 Asia/Kolkata (19.06, 72.83, 200 m); this import replaces it with 19.0596,
  > 72.8295, 150 m

  It is a warning, not a blocker. To keep the app's values, put them in file 04.

## Matching punches to shifts: one rule, in SQL

`hr.attendance_timeline` is a pure function: a worker's shifts and clock sessions go in,
and rows come out. Everyone sees the same answer, because one rule serves:

- My shifts and Clock (`hr.my_timeline`);
- managers (`hr.worker_timeline`);
- the nightly exceptions job, which the managers' exceptions screen shows.

### Matching

- **A closed session belongs to every shift it overlaps.**
- **An open session belongs to the shift it started in.** So a forgotten clock-out never
  spreads into tomorrow's shift.
- **A session that overlaps no shift** belongs to the nearest shift it starts or ends
  within 30 minutes of. Otherwise it is **unrostered**.
- **A session spanning two shifts** is cut at the second shift's start. The gap between
  them belongs to the first shift.
- `hr.clock` picks a punch's shift with the same rule. It used to allow from 2 h before
  the start.

### Splitting extra time

- **Extra time gets its own row** ("Extra before shift" or "Extra after shift") when it is
  at least `extra_time_min_minutes`. That is a company setting in file 15, default 30.
- **Shorter differences show only in the shift's In/Out.**
- **Time worked entirely outside a shift is always its own row.**

Your two examples, for a shift 08:00–20:00:

| Worked      | Rows                                                              |
| ----------- | ----------------------------------------------------------------- |
| 07:00–19:00 | 07:00–08:00 extra before shift; 08:00–19:00 shift, left 1 h early |
| 07:45–20:10 | one shift row, In 07:45 · Out 20:10, on time                      |

### Statuses

- **Late** and **left early** use the same threshold, `late_threshold_min` (10 minutes).
  When both apply, both are shown.
- **Clocked out** is shown while the shift is still running: it isn't "left early" until
  the shift ends.
- **Missing clock-out**: still open 4 h after the shift ended, or 16 h after an
  unrostered clock-in. These are the nightly job's existing times.

### The nightly job

The nightly job reads each worker's timeline for the last few days. It raises:

- late, no-show, missing clock-out and unscheduled, as before;
- **left_early**, a new exception kind (the minutes are in its detail).

Exceptions raised before this release stay as they are.

### Tests

The matching cases are tested on the pure function with literal times, with no tables
involved:

- your two examples;
- overnight shifts;
- a session spanning two shifts, and the 15 vs 30 minute setting;
- a session within 30 minutes and one beyond it;
- a break, an open session, upcoming, due and no-show.

A further test shows the nightly job's exceptions match what the person and their manager
see.
