# Menu, recipes and costing — test data additions

These files add menus, recipes, prep items, batched cocktails and house mixers to both test customers.
They are additions: files 10, 11 and 12 keep every existing row unchanged and only gain new rows at the end.

## New raw items (appended to 10, 11, 12)

- Test Company: Curd, Campari, Sweet Vermouth, Triple Sec, Coffee Liqueur, Angostura Bitters, Coffee Beans.
- Test Solo Bar Co.: the same, plus Sunflower Oil, Salt, Red Chilli Powder, Garam Masala, Turmeric Powder and Tomato Ketchup for its kitchen.

## How it fits together

```
raw item (bought, counted in stock units: kg, bottle, can)
   │  18: converted to a recipe unit (g, ml, each)
   ▼
prep item (made in-house in batches: gravies, pastes, syrups, batched cocktails)
   │  21: recipe lines, scaled to a batch yield; 19: batch size and shelf life
   ▼
menu item (what is sold: a dish, a peg, a cocktail, a glass of sangria)
      21: recipe lines from raw and/or prep items; 23: price and the store it is sold from
```

Making a batch is a production movement: ingredients leave the store and the prep item arrives in it.
Selling a menu item uses up its recipe from the store in file 23.

## Files

| File                            | What it defines                                                                                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `18_item_unit_conversions.csv`  | For every raw item: its stock unit, the unit recipes use, and how many recipe units are in one stock unit (1 kg = 1000 g; 1 vodka bottle = 750 ml; 1 tonic can = 300 ml; 1 lemon = 1 each)                                                                      |
| `19_prep_items.csv`             | Items made in-house: type (`kitchen_prep`, `house_mixer`, `batched_cocktail`), unit, standard batch yield, shelf life in hours; optional for the batch label (ADR 076): `food_type` (veg, non_veg, egg), `allergens` (FSSAI's, `;`-separated), `batch_portions` |
| `20_prep_locations.csv`         | Where each prep item is held, whether it is made there (`made_here`) or received by transfer, and its par level                                                                                                                                                 |
| `21_recipes.csv`                | Recipe lines for prep items and menu items: ingredient, quantity in the recipe unit, and trim loss % (the part thrown away while preparing, e.g. prawn shells)                                                                                                  |
| `22_menu_items.csv`             | What is sold: name, menu (Food/Bar), category, serving                                                                                                                                                                                                          |
| `23_menu_outlets.csv`           | Which outlet sells which menu item, the price before tax, and the store its ingredients come from; optional `pos_code`, the item's code on the outlet's POS for the POS import (ADR 039)                                                                        |
| `24_prep_procedures.csv`        | Method steps and minutes for each prep item, and for a dish with `recipe_for_kind` = `menu` (ADR 078)                                                                                                                                                           |
| `98_prep_costing_GENERATED.csv` | Generated, not filled: cost of one batch and cost per g/ml of each prep item                                                                                                                                                                                    |
| `98_menu_costing_GENERATED.csv` | Generated, not filled: cost per serve and cost % for every menu item at every outlet                                                                                                                                                                            |

## Examples worth checking

- **Central kitchen gravies:** Makhani Gravy and Onion Tomato Masala are made only at the Test Central Kitchen and transferred to the hotels, the guest house and Bar 3.0 (`made_here = no` there).
- **Pegs:** Vodka (30 ml) uses 30 ml from the vodka bottle; the bar counts bottles, the recipe pours ml.
- **Bought mixers:** Gin & Tonic uses a whole 300 ml tonic can; Mojito uses 100 ml from an open 750 ml soda bottle.
- **House mixers:** Sugar Syrup and Sour Mix are prep items; Sour Mix itself uses Sugar Syrup (a sub-recipe inside a sub-recipe).
- **Batched cocktails:** Negroni, Old Fashioned and House Sangria are made in batches; a Negroni served is 90 ml from the batch, costed from the batch.
- **Guest House:** sells a small food menu from its single stock location (no separate stores).

## Costing rule used in the 98 files

Cost of a line = quantity ÷ (1 − trim loss %) × cost per recipe unit.
Cost per recipe unit of a raw item = standard unit cost ÷ recipe units per stock unit.
Cost per unit of a prep item = total cost of its batch ÷ batch yield.
Water used for dilution or syrups is free and not listed.

A dish's photo goes in the zip's `photos/menu/<dish code>.jpg` (or `.png`, `.webp`), 2 MB at most;
the dry run lists it under "dish photos" and nothing is stored until it is applied (ADR 078).
