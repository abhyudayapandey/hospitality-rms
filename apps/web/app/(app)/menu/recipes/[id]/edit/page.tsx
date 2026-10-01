import { notFound } from 'next/navigation';
import { Empty } from '@/components/messages';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { isUuid, param, type SearchParams } from '@/lib/inventory';
import { ingredientOptions, menuPlaces, myRecipes, recipeCard } from '@/lib/menu';
import { RecipeEditor } from './recipe-editor';

// Changing a recipe makes a new version from a date (today or later). The database checks
// MENU modify at every store the recipe is used at, the units and that no prep item is
// made from itself; this page only offers the form to someone who may edit at the store.
export default async function EditRecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const sp = await searchParams;
  const user = await requireUser();
  const data = await withUser(user.id, async (tx) => {
    const recipe = (await myRecipes(tx)).find((r) => r.recipe_id === id);
    const place = (await menuPlaces(tx)).find((p) => p.store_id === param(sp, 'store'));
    if (!recipe || !place?.can_edit) return null;
    return { recipe, lines: await recipeCard(tx, id), options: await ingredientOptions(tx) };
  });
  if (!data) return <Empty>You can&rsquo;t change this recipe.</Empty>;
  const back = `/menu/recipes/${id}?${new URLSearchParams({
    store: param(sp, 'store'),
    ...(param(sp, 'outlet') && { outlet: param(sp, 'outlet') }),
  }).toString()}`;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Change {data.recipe.name}</h1>
      <RecipeEditor
        recipe={data.recipe}
        lines={data.lines.map((l) => ({
          ingredient_item_id: l.ingredient_id,
          qty: String(Number(l.qty)),
          trim_loss_pct: String(Number(l.trim_loss_pct)),
        }))}
        options={data.options.filter((o) => o.item_id !== data.recipe.subject_id)}
        back={back}
      />
    </div>
  );
}
