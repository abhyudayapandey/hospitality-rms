# 078 — A dish's photo and its recipe, with the sub-recipes it uses

Status: accepted · 2026-10-08 · migration 20261203100000

The Passport Hotel's GM (round 1, items 2 and 8) asked for a photo of each dish and for a dish's
page to show its ingredients and how it is made, where an ingredient that is itself made in the
kitchen (a masala, a syrup) opens its own recipe.

## Decision

1. **A dish has a photo**, like a stock item (ADR 034): in the private photo bucket under
   `items/<company>/<dish>/<uuid>.<ext>`, the item photos' prefix, so the app and the platform
   worker already have the rights (no `/infra` change); ids are unique across tables, so a key
   still names one company and one thing. It is set, changed or cleared only through
   `menu.set_dish_photo`, by whoever may change the dish's recipe: MENU modify at every store
   it is sold from (`menu.can_edit_dish`, `inv.save_recipe`'s rule). The upload is the same:
   resized on the phone, a presigned POST, nothing kept on the instance.
2. **Onboarding: a folder in the import zip**, `photos/menu/<dish code>.<jpg|png|webp>`, beside
   the CSV files; not a photo column. A column would hold web links, and the worker would then
   fetch from wherever a link points; shared-drive links need a sign-in and go stale. In the
   zip, the upload checks every picture (its real type by its first bytes, 2 MB at most, 300 at
   most, one per dish) and the dry run reports them like any other change ("dish photos").
   Apply stores each new picture under a key made from its content, so the same picture again
   changes nothing. The pictures go to the bucket only when the load commits.
3. **A dish has a method**, in file 24 beside the prep items': an optional `recipe_for_kind`
   column (`prep`, the default, or `menu`), as file 21 has. `inv.prep_procedure` rows belong to a
   prep item or a dish, never both; whoever reads the recipe reads its method
   (`inv.recipe_method`), and the table's row security follows the same rule.
4. **The recipe page has two tabs**, Ingredients and Recipe (the method; "No method yet" when
   there is none), under the photo. An ingredient that is a prep item the person may read opens
   that recipe on its Recipe tab (`inv.sub_recipes`). Who sees ₹ is unchanged.

## Consequences

- Test Company's Butter Chicken and Paneer Butter Masala have methods; Butter Chicken has a
  photo in `photos/menu/`. The Passport demo's two signature cocktails and its ros omelette
  have methods.
- The upload limit is 25 MB (40 MB unpacked) to carry the photos.
