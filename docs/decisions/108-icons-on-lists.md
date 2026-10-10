# 108. Pictures where lists were still text

Date: 2026-10-10. Status: accepted. Plan: `docs/plans/ux-audit.md` (PR 5, its people part).

## Decision

1. **Shifts** on the roster (by shift, the list and the by-person tiles) and on My shifts carry
   the shift type's picture (`shiftIcon`, `lib/shift-types.ts`): a split shift two blocks
   (ADR 082), a panzer the moon, a straight shift the sun when it starts between 05:00 and
   14:59 where it is worked, else the moon.
2. **Notifications** carry the picture of what they are about (`notificationIcon`): tasks,
   leave, swaps, the roster, orders, stock, expiry, repairs, compliance, access; else the bell.
3. **Clock history** rows show in and out as arrows, the words kept for screen readers.
4. **People rows** (Team → People, Team → Leave, Admin → Users, the To do list's requests and
   the roster by person) start with a round initials badge like the header's
   (`components/initials.tsx`). Home's compact requests are left as they are.
5. My shifts' clock card uses the clock line icon, not an emoji.
