# 045 — Clock-in device and selfie

Status: accepted · 2026-10-04 (migration 20261103100000)

Prospect feedback (3 Oct), ATT-7: clock-in records the device and a selfie, and the
exceptions screen flags a new device or one device used by several people.

## Decision

1. **Selfie at clock-in only** (not clock-out). The phone's camera opens when "Clock in"
   is tapped; the photo is shrunk to 640 px, JPEG 0.6 (about 50 to 80 KB), uploaded with a
   presigned POST to `selfies/<company>/<place>/` (the person's own place; the server picks
   it) and its key goes to `hr.clock`. **A phone with no camera clocks in and is flagged
   `no_selfie`**, never blocked, like a missing location (ATT-1). "No camera? Clock in
   without a selfie" is on the screen.
2. **Offline.** The selfie stays on the phone in IndexedDB with the punch (`punch-queue`)
   and uploads when the punch syncs, with the original time. A selfie that will not upload
   while the phone is online is dropped after three tries; the punch matters more.
3. **Device.** A random id in the browser's storage plus the phone model from the user
   agent (a hint: iPhones and reduced Android agents give little). `hr.worker_device` keeps
   each person's devices. **New device:** flagged only once the person's first device is
   more than **7 days** old (a phone change in the first week is normal). **Shared device:**
   one device used by more than one person **on the same local day**, flagged on every
   punch that used it. Flags are `attendance_exception` kinds (`no_selfie`, `new_device`,
   `shared_device`) on the existing screen and queue; nothing blocks.
4. **Who sees a selfie.** A new org-tree domain `ATTENDANCE_SELFIES` (view): **HR (Outlet
   HR, HR Admin), the head of the person's department, and the person**. Not the GM, the
   area manager or the Account Owner. Selfies live in their own table
   (`hr.attendance_selfie`) so that RLS, and `hr.selfie_of` / `hr.exception_selfies`, use
   that domain and the people who see attendance do not all see faces. The screens show a
   selfie through a 5-minute signed URL, only where the database returns its key.
5. **Retention (NFR Data retention, decided 3 Oct).** Personnel data is kept for at least a
   year and back to the start of the previous calendar year and the previous financial year
   (1 April), whichever is earliest (`hr.personnel_cutoff`; 1 January 2025 in September
   2026). `hr.purge_personnel` runs in the nightly attendance job: it removes selfies
   (the row stays, with `purged_at`, and the clock-in stays) and devices older than that.
   **The bucket also has a 731-day lifecycle rule on `selfies/`** as a backstop (the app has
   no delete right on S3), so there is a CDK change (and `cdk diff` step) with this release.
   The rest of the personnel retention rule (attendance, leave, shifts, pay) is **not**
   enforced yet; it is outside this change.

## Consequences

- Every clock-in without a selfie adds an exception to review, which is noisy where phones
  have no camera; the screen's "resolve" works as for any exception. Existing e2e and
  tests clock in without a selfie and expect the flag.
- The device id lives in localStorage: clearing site data makes a device "new", and a
  shared phone is only spotted when both people use the same browser profile.
