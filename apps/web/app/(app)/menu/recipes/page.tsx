import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { menuPlaces, myRecipes } from '@/lib/menu';
import { MenuTabs, RecipeList } from '../parts';

// Recipes and prep procedures for cooks and bartenders: what they may read (RLS), with
// batch sizes and shelf life, never a cost.
export default async function RecipesPage() {
  const user = await requireUser();
  const { recipes, places } = await withUser(user.id, async (tx) => ({
    recipes: await myRecipes(tx),
    places: await menuPlaces(tx),
  }));
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Recipes</h1>
      <MenuTabs active="recipes" costs={places.length > 0} />
      <RecipeList recipes={recipes} />
    </div>
  );
}
