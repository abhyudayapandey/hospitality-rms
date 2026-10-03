# 036 — Test attendance skips sessions that clash with real ones

Status: accepted · 2026-10-03

File 35 (test customers only, ADR 030) loads a past week of attendance as the test people.
On production, people sign in as those test users and clock in for real. A real session
that overlaps a test one (often one never clocked out, which runs on to "now") made
`hr.record_test_attendance` refuse with `INVALID_DATE: overlaps another session`, and the
whole import stopped. That was found re-importing Test Company on production (row 91,
`test.commis.1.0`).

## Decision

The loader checks each test session against the person's sessions already in the app. A
clash skips that one row and adds a warning naming the person, the test session and when
the real one started; the rest of the file loads. The real session is kept: it is what
someone actually did. `attendance sessions` counts only the sessions recorded.

The database function still refuses an overlap: the check in the loader only decides to
skip instead of failing.

The import report's warnings box is now headed "N warning(s)", since it holds more than
approval coverage (also locations set in the app, ADR 018, and these).

## Consequences

The labour and People figures for that person on those days come from their real
sessions, so they can differ from `docs/onboarding/test-data/README.md`. The pinned tests
run on a fresh database, where there are no real sessions, and are unchanged.
