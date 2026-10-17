# 169. App behaviour, speed and time

Date: 2026-10-17. Status: accepted. Migrations 20270122100000 to 20270122140000.

## Context

The platform review of 2026-10-16 found the app losing typed work when a tap got no answer,
imports that broke once their upload expired, migrations named out of order, screens and jobs
that took UTC or India's time for the outlet's day, and lists, photos and jobs that did more
work than they needed. This ADR records the rules for them.

## Decision

1. **A tap that gets no answer** (H13, L39, L42). Every form calls its server action through
   `callAction` (`lib/call-action.ts`): a failed request returns `OFFLINE` ("No connection. Try
   again.") in place, the form keeps what was typed, and the retry sends the same idempotency
   key. An action the server no longer has (an old build) is `APP_UPDATED`, and the version
   check asks at once. `useActionKey` makes one key per decision and a new one only after it
   succeeds. Server actions share `runAction` (`lib/run-action.ts`); upload errors share
   `uploadMessage` (`lib/upload-error.ts`).
2. **Uploads are kept in the database** (H11). The console stores an upload's files and dish
   photos in `platform.upload` (`platform.keep_upload`), which never expires, and the worker
   reads it there first (`platform.kept_upload`). `platform.current_files` returns the files
   of the last applied import, so Add an outlet and a late apply never need the bucket. An
   upload made before this change is still read from the bucket; once that copy has expired,
   it is imported again.
3. **Migrations in order** (H12). `pnpm db:new` names a file one second after the newest one;
   a test checks the newest file sorts last and no file is dated before one already applied;
   CI runs dbmate with `--strict`.
4. **The outlet's own day and zone** (M27, M28, M32, M34, L31). Every date and time helper
   takes the time zone (`formatWhen(d, tz)`, `dueText`, `todayIn`), from the place or the
   person's workplace (`Shell.tz`); forms default to the business day there, never the UTC
   date. A round after midnight belongs to the night it began (`ops.occurrence_days`), so it
   keeps that night's steps. The next meal goes by the business day (`ops.meal_next`): a cut-off
   before 04:00 is that night. `ops.today_at` is the business day. Tests compute today as the
   business day in the outlet's zone.
5. **Speed** (M35, M36, M40, M41, M42, L35). Expiry alerts look only at stores with a batch
   due by tomorrow and skip stores whose leads were told today. The app's pool is bounded
   (`DB_POOL_MAX`, 15), waits 10 s for a connection, and each connection sets a 60 s statement
   and idle-in-transaction limit and a 15 s lock wait (`appPoolConfig`). The To do list reads
   every transfer's ask and stock levels in one query each. A photo's signed address stays the
   same for 5 minutes (signed from the start of the window), so a refresh reuses the cached
   photo. Logbook, Registers, Breakage show 30 then Show more, Notifications 50, Stock 150; the
   unread badge and Mark all read are counted from unread rows in SQL. The roster week and Home
   load their parts side by side; Home refreshes every minute.
6. **Offline and the service worker** (M37, M38, L34, L43). Only a GET page is cut short after
   10 s; the "Can't reach" screen tries again with a GET, waiting 10 s, 20 s, 40 s, then 60 s.
   A saved item the server fails is tried again later without holding up the rest; after 3
   tries it shows as not sent, and the person may discard it. An old build holds saved items
   until the reload. Sign out warns once when something is saved on the phone and not sent.
7. **Our own words** (M39, L36, L37). An unknown address and a crash show the app's own
   screens (`not-found.tsx`, `global-error.tsx`). An event's status reads in words. "← Back"
   from an item or a bill returns to the list as it was (`withBack`).
8. **Small guards** (L4, L5, L6). A key from the address bar finds only a record's own entry
   (`own`). The sign-in cookie is cleared on the path it was set on. A page and its prefetches
   share one Cognito refresh (`sharedRefresh`).

## Consequences

- Role-level timeouts would need a change to the database bootstrap; the app sets them per
  connection instead.
- The bucket's 30-day rule can stay as it is; nothing new is written under `onboarding/`.
