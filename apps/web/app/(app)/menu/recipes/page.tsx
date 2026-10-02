import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { menuPlaces, myRecipes } from '@/lib/menu';
import { salesPlaces } from '@/lib/production';
import { loadShell } from '@/lib/shell';
import { MenuTabs, RecipeList } from '../parts';

// Recipes and prep procedures for cooks and bartenders: what they may read (RLS), with
// batch sizes and shelf life, never a cost.
export default async function RecipesPage() {
  const user = await requireUser();
  const on = (await loadShell()).modules.has('menu_sales');
  const { recipes, places, sales } = await withUser(user.id, async (tx) => ({
    recipes: await myRecipes(tx),
    // costs, sales and variance only with Menu and sales on (ADR 026)
    places: on ? await menuPlaces(tx) : [],
    sales: on ? await salesPlaces(tx) : [],
  }));
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Recipes</h1>
      <MenuTabs active="recipes" costs={places.length > 0} sales={sales.length > 0} />
      <RecipeList recipes={recipes} />
    </div>
  );
}
