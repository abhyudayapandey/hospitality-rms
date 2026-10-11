# 127. A live photo on every step; fire extinguishers in Compliance

Date: 2026-10-11. Status: accepted. Migrations `20261220160000_photo_every_step`,
`20261220130000_licence_location_type`.

## Decision

1. **Every step of every task takes a photo**, for everyone, every room of a room round
   included (`ops.complete_step` refuses one without `PHOTO_REQUIRED`). A task with no steps
   takes a photo of the job done before it is marked done. A batch, a discard, a sign-off, a
   handover read and the minibar's refill and bill keep their own flows.
2. **The live camera only**: `PhotoField` opens the back camera and takes the picture; it never
   offers the phone's gallery. A dish's or an item's catalogue photo may still be picked.
3. The loader's replay of a test customer's past tasks (file 30) needs no photo
   (`app.replay`, test customers only).
4. Where a server has no bucket (local development, e2e), photos are kept on its disk
   (`PHOTO_DIR`, `/api/photo-local`, signed links with `SESSION_SECRET`, 5 minutes). Never
   where `PHOTO_BUCKET` is set.
5. **Fire extinguishers** are licences of kind `FIRE_EXTINGUISHER` with where they hang
   (`location`) and their type (CO2, ABC powder, foam, water, wet chemical, clean agent):
   their refill or expiry date is on the Compliance card like any licence, and a renewal keeps
   both. File 38 has `location` and `equipment_type`.

## Tests

`tasks.db.test.ts` (a bare tick is refused), `room-grid.db.test.ts`, `compliance.db.test.ts`,
e2e with Chromium's fake camera.
