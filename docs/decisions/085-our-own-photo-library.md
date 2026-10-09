# 085 — Our own photo library: real photos of items and brands, freely licensed

Status: accepted · 2026-10-09 · no migration

ADR 084 shows a picture of the thing itself on every item line, as a real photo from a library
we keep. The GM asked for the photos to look like the real product, branded bottles included, at
no cost, with no contract, and without asking outlets to supply them.

## Decision

1. **One library, ours, the same for every customer.** The photos are files in the app
   (`apps/web/public/pictures/<key>.webp`), listed in `apps/web/lib/picture-photos.ts`. Outlets
   never supply them; an item's own photo (ADR 034) still comes first.
2. **Only freely licensed photos, from Wikimedia Commons.** Every Commons file carries a free
   licence (public domain, CC0, CC BY, CC BY-SA), so using one costs nothing and needs no
   contract; the attribution licences need the author and licence named, which the credits do.
   Product photos on retailers' and brands' sites belong to whoever took them, and copying them
   without permission invites takedowns, so we do not use them, even where they are widely
   copied.
3. **Brands are pictures too.** The catalogue (`packages/domain/src/pictures.ts`) has about 110
   brands common in Indian hotels, bars and kitchens (Old Monk, Kingfisher, Amul Butter,
   Harpic…), each with its `kind`, the generic picture it is (Old Monk is a dark rum). A brand
   named anywhere in an item's name wins over everything else; a brand with no photo of its own
   yet shows its kind's photo, else its kind's line icon.
4. **Picked by eye, built by a script.** The photo for each key is chosen by a person and
   recorded in `apps/web/scripts/photos/library.json` (key → Commons file). `pnpm --filter
@outlet-ops/web photos` downloads each at 500 px, paced as Commons asks, flattens it on
   white, trims the background, fits it in a 320 px square and writes WebP, then regenerates
   `picture-photos.ts` and `picture-credits.ts` (author, licence, link). A key left out of
   `library.json` shows its kind or its line icon; nothing breaks.
5. **Credits are in the app**: Profile → Picture credits lists every photo with its author, licence
   and source.
6. **A test keeps it whole** (`apps/web/lib/pictures.test.ts`): every photo is for a key in the
   catalogue, has its file under 60 KB, and is credited to a Commons page; no file is left over.

## Consequences

- The library grows by adding a line to `library.json` and running the script; a photo that
  turns out wrong is replaced the same way.
- Brands whose packaging has no free photo on Commons show their kind's photo until one exists.
- The photos add a few megabytes to the release; the browser fetches only those it shows
  and keeps them.
