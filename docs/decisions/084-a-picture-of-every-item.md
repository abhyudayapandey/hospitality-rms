# 084 — A picture of every item, portions per batch, and photos before the finishing button

Status: accepted · 2026-10-09 · migration 20261209100000

After ADR 078 to 082 went live, the Passport Hotel's GM, as the commis, the bartender and the
executive chef:

- the kitchen's staff are often unable to read much: they remember pictures and rarely read
  the text, so every ingredient needs a picture of the thing itself (chilli looks like chilli,
  garlic like garlic, clove like clove, cumin like cumin), not a common icon for its kind;
- a recipe said what a batch makes in grams but not how many servings;
- "Photos (kept 30 days)" told every employee something only managers need;
- the prep list squeezed each name into one word a line;
- the task's photos came after "Record the batch", though they are part of recording it;
- "Batch tepache for the weekend" looked nothing like "Make Recheado masala".

## Decision

1. **A picture of the thing itself on every item line.** A catalogue in product code
   (`packages/domain/src/pictures.ts`, 250 pictures) names each picture and the words that mean
   it, in English, Hindi and Konkani (jeera, lavang, dalchini, haldi, lehsun, imli, kokum…). An
   item's picture comes from its **name**: the longest phrase wins, then the one furthest right
   ("coconut curry base" is a curry base); the head before a comma or bracket decides first
   ("Chicken, curry cut" is chicken; "Refined Flour (Maida)" is maida); plurals match. Only
   when nothing in the name matches does its **category** give the picture, and the onboarding
   dry run lists every such item as a warning, so the words grow with each customer. There is
   no per-item picture column: matching at display keeps every screen, every customer and every
   item added later in step, with no backfill.
2. **Real photos, not drawings.** Each picture is shown as a real photo of the thing itself,
   cut out on a plain light tile, from a library we keep (`apps/web/lib/picture-photos.ts`,
   files in `apps/web/public/pictures`), the same for every customer; customers never supply
   them. Emoji and drawn pictures were tried and turned down: they read as childish. Until the
   library has a key's photo, the line shows the app's own line icon for the item's kind
   (produce, drinks, linen, prep, meat and dairy, else a box), as before this decision; an
   item's own photo (ADR 034) still comes first. The library's photos come in their own change.
3. **Shown big** (`ItemThumb`; photos on the palette's `tile` and `tile-edge`), on every list
   and form that names items: stock, the item, counts and stock checks, orders, receiving,
   requests, sending, transfers, wastage, Make and batches, the prep list, a prep task's
   ingredients, recipes and their ingredients, the menu, sales, the minibar, events and the
   reports' item lists. A dropdown cannot hold pictures, so the chosen item's picture stands
   beside it.
4. **Portions per batch.** A recipe shows "Batch makes 500 g · about 20 portions"
   (file 19 `batch_portions`, ADR 076; `inv.my_recipes` returns it), and a prep task "Makes
   about 10 portions" for its quantity (`ops.prep_task_recipe`'s `portions`).
5. **A task's photos sit above the button that finishes it**, on every kind of task, headed
   "Photos". How long routine photos are kept (ADR 079) is unchanged and no longer shown.
6. **The prep list gives each name its own line**: picture and name, then par and on hand, then
   "Make" and the quantity at a fixed width. A plain `w-*` beside the shared input style's
   `w-full` lost; such inputs use `max-w-*`.
7. **The Passport tepache is a prep task** (file 32) from the bar's prep list, opening on its
   ingredients for the litre, its method and Record the batch, like every other thing to make.
   A one-off task (file 30) is for work that is not making something with a recipe.

## Consequences

- A new kind of item at a customer shows its category's picture until its word is added; the
  dry run says which.
- The same name always shows the same picture, everywhere and for everyone.
- The wider work of making every screen simpler for staff who read little is the next piece of
  work, on its own.
