# 055 — Every tap answers at once; screens build faster; a new version offers a reload

Status: accepted · 2026-10-06 (no migration)

On iPhone and Android, a tap showed nothing for 2–3 s, so people tapped again and the app felt
slow. There were two causes:

- **No loading state.** No screen had a `loading.tsx`. Every screen is built on the server for
  the person, so the old screen stayed up, untouched, until the new one was complete.
- **A fixed cost on every request.** The app layout's `loadShell` ran three access checks only
  to choose the bottom-nav tabs: `rpt.my_reports()`, `menu.my_menu_places()` and
  `core.screen_places('production')`. Together they took about 435 ms for the General Manager.
  On the t4g.small and a phone network, that is most of the wait.

## Decision

1. **A skeleton the moment a screen is tapped.**
   - Every screen under `app/(app)` has a `loading.tsx` that shows `components/page-skeleton`:
     a title, tabs and list rows in the palette's colours.
   - Next.js prefetches it, so it shows in well under 100 ms. The real screen streams in when
     it is ready.
2. **Tap feedback** (`components/nav-progress.tsx`, `globals.css`):
   - Anything tapped looks pressed at once.
   - The tapped link is dimmed and a thin bar runs along the top until the screen is in. The
     skeleton carries the bar on.
   - A second tap on a link already loading, or on the screen whose skeleton is up, is ignored.
   - Every submit button was already disabled while saving.
3. **The bottom nav's checks are remembered, not the access** (`lib/shell.ts`):
   - The answers to "is there a Menu, Make and Reports tab" are kept on the server per person.
     The key is the person, their home place, their domains, their modules and their product
     roles, so a change to any of these asks again on the next tap.
   - Anything else asks again after 5 minutes, for example a company's first recipe making the
     Menu tab appear.
   - It is not decided at login: an installed app stays signed in for days, and the tabs must
     follow a change made in the meantime.
   - Only the nav reads these answers. Every screen and every row is still checked by the
     database on each request (rule 2), so access that is taken away stops at once.
4. **A new version offers a reload** (`components/version-check.tsx`, `/api/version`):
   - Each build has one id: the commit in CI (`GITHUB_SHA` or `GIT_SHA`), otherwise the build
     time. It goes into both the server and the page's code (`NEXT_PUBLIC_BUILD_ID`).
   - An open app asks the server for its build when it comes back to the screen and every
     5 minutes.
   - When the two differ, a bar says "A new version of the app is ready" with a **Reload**
     button.
   - Nothing else changes about updates. Screens always come from the server, and the service
     worker caches only the offline page, so a deploy reaches everyone on their next screen.

## Measured

Local server time per screen, median of 4, fresh seed:

| Screen                  | Before | After  |
| ----------------------- | ------ | ------ |
| GM: To do list          | 440 ms | 70 ms  |
| GM: Stock               | 553 ms | 149 ms |
| GM: Home                | 837 ms | 428 ms |
| Store keeper: Transfers | 386 ms | 83 ms  |
| Store keeper: Count     | 401 ms | 88 ms  |
| Store keeper: Orders    | 660 ms | 372 ms |
| Chef: Ask for supplies  | 492 ms | 86 ms  |

## Not in this change

Home and Orders still spend about 125 ms in the permission checks on the order lists. Those
checks are `core.can` per row under RLS, over the purchase order summary and the desk's lists.
Making them cheaper (`core.can` remembering its answers within a transaction) touches the core
of access, so it gets its own change and its own tests.
