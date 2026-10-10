import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ItemThumb } from '@/components/item-thumb';
import { Empty } from '@/components/messages';
import { MethodSteps } from '@/components/method-steps';
import { ViewTabs } from '@/components/view-tabs';
import { requireUser } from '@/lib/auth/server';
import { withUser } from '@/lib/db';
import { formatMoney, portionsText } from '@/lib/format';
import { formatQty, isUuid, param, type SearchParams } from '@/lib/inventory';
import {
  canEditDish,
  lineCosts,
  menuPlaces,
  myRecipes,
  outletCosting,
  recipeCard,
  recipeMethod,
  recipePhotoKeys,
  subRecipes,
} from '@/lib/menu';
import { itemPhotoUrls, photosEnabled } from '@/lib/photos';
import { shelfLifeText } from '@/lib/shelf-life';
import { DishPhoto } from './dish-photo';
import { PriceForm } from './price-form';

// One recipe: its photo, then two tabs (ADR 078): Ingredients for a batch (prep) or a serve
// (a dish), where a prep item opens its own recipe, and Recipe, the method, a prep item's
// or a dish's. Costs only with ?store= where the person holds MENU view; editing only with
// MENU modify there (the database checks every store the recipe is used at).
export default async function RecipePage({
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
    if (!recipe) return null;
    const lines = await recipeCard(tx, id);
    const steps = await recipeMethod(tx, id);
    const subs = await subRecipes(tx, id);
    const photo = (await recipePhotoKeys(tx)).find((p) => p.item_id === recipe.subject_id);
    const photoUrl = photo ? (await itemPhotoUrls([photo])).get(photo.item_id) : undefined;
    const canPhoto = recipe.kind === 'menu' && (await canEditDish(tx, recipe.subject_id));
    const places = await menuPlaces(tx);
    const place = places.find((p) => p.store_id === param(sp, 'store'));
    const costs = place ? await lineCosts(tx, id, place.store_id) : null;
    const outlet = place && param(sp, 'outlet') === place.outlet_id ? place : null;
    const priced =
      outlet && recipe.kind === 'menu'
        ? (await outletCosting(tx, outlet.outlet_id)).find(
            (r) => r.menu_item_id === recipe.subject_id,
          )
        : undefined;
    return {
      recipe,
      lines,
      steps,
      subs,
      photo,
      photoUrl,
      canPhoto,
      places,
      place,
      costs,
      outlet,
      priced,
    };
  });
  if (!data) {
    return <Empty>You can&apos;t open this recipe.</Empty>;
  }
  const { recipe, lines, steps, subs, photo, photoUrl, canPhoto, place, costs, outlet, priced } =
    data;
  const tab = param(sp, 'tab') === 'recipe' ? 'recipe' : 'ingredients';
  const keep = new URLSearchParams(
    Object.entries({ store: param(sp, 'store'), outlet: param(sp, 'outlet') }).filter(
      (e): e is [string, string] => !!e[1],
    ),
  );
  const tabHref = (t: string) => {
    const q = new URLSearchParams(keep);
    if (t === 'recipe') q.set('tab', 'recipe');
    return `/menu/recipes/${id}${q.size ? `?${q}` : ''}`;
  };
  const cost = new Map(costs?.map((c) => [c.line_no, c]) ?? []);
  const total = costs?.reduce((s, c) => s + Number(c.line_cost ?? 0), 0) ?? null;
  const editable = place?.can_edit ?? false;
  const back = outlet ? `/menu?outlet=${outlet.outlet_id}` : '/menu/recipes';
  const storeChoices = [...new Map(data.places.map((p) => [p.store_id, p])).values()];

  return (
    <div className="space-y-4">
      <Link href={back} className="text-sm text-slate-600 underline">
        ← Back
      </Link>
      {photoUrl && (
        // a presigned S3 URL that changes on every page: next/image would cache it for nothing
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl}
          alt={recipe.name}
          data-testid="dish-photo"
          className="aspect-[4/3] w-full rounded-xl object-cover ring-1 ring-slate-200"
        />
      )}
      <div className="flex items-start gap-3">
        {!photoUrl && (
          <ItemThumb
            name={recipe.name}
            category={recipe.grp}
            fallback={recipe.kind === 'menu' ? 'dish' : 'gravy'}
            size="size-16"
          />
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold" data-testid="recipe-name">
            {recipe.name}
          </h1>
          <p className="text-sm text-slate-600">{recipe.grp}</p>
          {recipe.kind === 'prep' && (
            <p className="mt-1 text-sm" data-testid="batch">
              Batch makes <strong>{formatQty(recipe.batch_yield!, recipe.unit!)}</strong>
              {recipe.batch_portions && (
                <>
                  {' '}
                  ·{' '}
                  <strong data-testid="portions">
                    about {portionsText(recipe.batch_portions)}
                  </strong>
                </>
              )}{' '}
              · <strong>{shelfLifeText(recipe.shelf_life_hours)}</strong>
            </p>
          )}
        </div>
      </div>
      {canPhoto && photosEnabled() && <DishPhoto dish={recipe.subject_id} has={!!photo} />}

      <ViewTabs
        label="Recipe"
        current={tab}
        tabs={[
          { key: 'ingredients', label: 'Ingredients', href: tabHref('ingredients') },
          { key: 'recipe', label: 'Recipe', href: tabHref('recipe') },
        ]}
      />

      {tab === 'ingredients' && !place && storeChoices.length > 0 && (
        <p className="text-sm">
          Costs at:{' '}
          {storeChoices.map((p, i) => (
            <span key={p.store_id}>
              {i > 0 && ', '}
              <Link className="underline" href={`/menu/recipes/${id}?store=${p.store_id}`}>
                {p.store_name}
              </Link>
            </span>
          ))}
        </p>
      )}

      {tab === 'ingredients' && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">
            {recipe.kind === 'prep' ? 'Ingredients for one batch' : 'Ingredients for one serve'}
            {place && <> · costs at {place.store_name}</>}
          </h2>
          <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
            {lines.map((l) => (
              <li
                key={l.line_no}
                data-testid="recipe-line"
                className="flex items-center gap-3 px-4 py-3"
              >
                <ItemThumb name={l.name} fallback={l.kind === 'prep' ? 'gravy' : undefined} />
                <span className="min-w-0 flex-1">
                  {subs.has(l.line_no) ? (
                    <Link
                      href={`/menu/recipes/${subs.get(l.line_no)}?tab=recipe`}
                      data-testid="sub-recipe"
                      className="block font-medium text-brand-700 underline"
                    >
                      {l.name}
                    </Link>
                  ) : (
                    <span className="block font-medium">{l.name}</span>
                  )}
                  {Number(l.trim_loss_pct) > 0 && (
                    <span className="text-xs text-slate-500">
                      {Number(l.trim_loss_pct)}% trimmed away
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  {formatQty(l.qty, l.unit)}
                  {cost.has(l.line_no) && (
                    <span className="block text-xs text-slate-500" data-testid="line-cost">
                      {formatMoney(cost.get(l.line_no)!.line_cost)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {total !== null && (
            <p className="text-right text-sm" data-testid="recipe-total">
              {recipe.kind === 'prep' ? 'Batch cost' : 'Cost per serve'}{' '}
              <strong className="tabular-nums">{formatMoney(total)}</strong>
              {recipe.kind === 'prep' && (
                <>
                  {' '}
                  · {formatMoney(total / Number(recipe.batch_yield))} per {recipe.unit}
                </>
              )}
            </p>
          )}
        </section>
      )}

      {tab === 'recipe' && steps.length === 0 && (
        <Empty>No method yet. Ask your chef or manager to add it.</Empty>
      )}
      {tab === 'recipe' && steps.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-500">Method</h2>
          <MethodSteps steps={steps} ingredients={lines} />
        </section>
      )}

      {editable && (
        <Link
          href={`/menu/recipes/${id}/edit?store=${place!.store_id}${outlet ? `&outlet=${outlet.outlet_id}` : ''}`}
          className="flex min-h-12 items-center justify-center rounded-lg border border-slate-300 bg-white font-medium"
        >
          Change recipe
        </Link>
      )}
      {editable && outlet && priced && (
        <PriceForm
          menuItemId={recipe.subject_id}
          outletId={outlet.outlet_id}
          outletName={outlet.outlet_name}
          price={priced.price}
        />
      )}
    </div>
  );
}
