import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EXTRA_BY_CODE, TILES, TILE_BY_CODE, missingBundleNotes } from '@outlet-ops/domain';
import {
  TemplateError,
  addOutlet,
  parseCsv,
  type OutletPlan,
} from '@outlet-ops/onboarding/templates';
import { ErrorBox, primaryButton, secondaryButton } from '@/components/messages';
import { withPlatformAdmin, sql } from '@/lib/db';
import { currentFiles } from '@/lib/platform/outlet-files';
import { requirePlatformAdmin } from '@/lib/platform/server';
import type { PlatformCustomer } from '../../../parts';
import { choiceFrom, one, type Search } from './choice';

// Add an outlet from a template (ADR 062): pick what the outlet is, tick what else is there,
// check what it adds, then the usual dry run and apply. For the sales and onboarding teams:
// plain words, a default for everything, and nothing that won't load.
export default async function AddOutletPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const { id } = await params;
  const q = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const admin = await requirePlatformAdmin();
  const {
    customer,
    files,
    plan: inPlan,
  } = await withPlatformAdmin(admin, async (tx) => ({
    customer: (
      await sql<PlatformCustomer>`select * from platform.customer(${id}::uuid)`.execute(tx)
    ).rows[0],
    files: await currentFiles(tx, id),
    // what the customer buys (ADR 067): an outlet never switches a module on
    plan: new Set(
      (
        await sql<{ bundle: string; in_plan: boolean }>`
          select bundle, in_plan from platform.customer_modules(${id}::uuid)`.execute(tx)
      ).rows
        .filter((m) => m.in_plan)
        .map((m) => m.bundle),
    ),
  }));
  if (!customer) notFound();
  const back = (
    <Link href={`/platform/customers/${id}`} className="text-sm text-slate-600">
      ← {customer.name}
    </Link>
  );
  if (!files) {
    return (
      <>
        {back}
        <h1 className="text-xl font-semibold">Add an outlet</h1>
        <ErrorBox message="We don't have this customer's set-up on file yet, so an outlet can't be added here. Upload their files first (Update from their files)." />
      </>
    );
  }
  const org = parseCsv(files[Object.keys(files).find((f) => f.startsWith('01_'))!] ?? '').rows;
  const under = org.filter((r) => ['company', 'region', 'area'].includes(r.values['kind']!));
  const timezone =
    parseCsv(files[Object.keys(files).find((f) => f.startsWith('00_'))!] ?? '').rows[0]?.values[
      'default_timezone'
    ] || 'Asia/Kolkata';

  const tile = TILE_BY_CODE.get(one(q.tile));
  if (!tile) {
    return (
      <>
        {back}
        <h1 className="text-xl font-semibold">Add an outlet</h1>
        <h2 className="font-semibold">What is this outlet?</h2>
        <ul className="grid gap-2 sm:grid-cols-2" data-testid="tiles">
          {TILES.map((t) => (
            <li key={t.code}>
              <Link
                href={`/platform/customers/${id}/add-outlet?tile=${t.code}`}
                className="flex min-h-16 flex-col justify-center rounded-xl bg-white p-3 ring-1 ring-slate-200"
              >
                <span className="font-medium">{t.name}</span>
                <span className="text-sm text-slate-600">{t.example}</span>
              </Link>
            </li>
          ))}
        </ul>
      </>
    );
  }

  const choice = choiceFrom(q, timezone);
  let plan: OutletPlan | null = null;
  let error: string | null = one(q.error) || null;
  const review = one(q.review) === '1' && choice.name && choice.parentCode;
  try {
    plan = review
      ? addOutlet(files, choice).plan
      : addOutlet(files, {
          ...choice,
          code: 'PREVIEW',
          name: 'Preview',
          parentCode: under[0]?.values['node_code'] ?? '',
        }).plan;
  } catch (err) {
    if (!(err instanceof TemplateError)) throw err;
    error = err.message;
  }

  const field = 'mt-1 block min-h-12 w-full rounded-lg border border-slate-300 px-3';
  return (
    <>
      {back}
      <h1 className="text-xl font-semibold">Add an outlet: {tile.name}</h1>
      <p className="text-sm text-slate-600">
        {tile.example}.{' '}
        <Link href={`/platform/customers/${id}/add-outlet`} className="underline">
          Change
        </Link>
      </p>
      <ErrorBox message={error} />
      <form method="get" className="space-y-4" aria-label="The outlet">
        <input type="hidden" name="tile" value={tile.code} />
        <input type="hidden" name="x" value="1" />
        <input type="hidden" name="d" value="1" />
        <input type="hidden" name="review" value="1" />
        <label className="block text-sm font-medium">
          Name
          <input
            name="name"
            required
            defaultValue={choice.name}
            placeholder="Bandra Café"
            className={field}
          />
        </label>
        <label className="block text-sm font-medium">
          Part of
          <select name="under" defaultValue={choice.parentCode} className={field}>
            {under.map((r) => (
              <option key={r.values['node_code']} value={r.values['node_code']}>
                {r.values['name']}
              </option>
            ))}
          </select>
        </label>

        {tile.offers.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="font-semibold">Anything else here?</legend>
            {tile.offers.map((x) => {
              const e = EXTRA_BY_CODE.get(x)!;
              return (
                <label
                  key={x}
                  className="flex min-h-12 items-start gap-3 rounded-lg bg-white p-3 ring-1 ring-slate-200"
                >
                  <input
                    type="checkbox"
                    name="extra"
                    value={x}
                    defaultChecked={choice.extras.includes(x)}
                    className="mt-1 size-5"
                  />
                  <span>
                    <span className="block font-medium">{e.name}</span>
                    <span className="block text-sm text-slate-600">{e.does}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}

        {plan && (
          <fieldset className="space-y-2" data-testid="departments">
            <legend className="font-semibold">Departments</legend>
            {plan.departments.map((d) => (
              <label
                key={d.code}
                className="flex min-h-12 items-center gap-3 rounded-lg bg-white px-3 ring-1 ring-slate-200"
              >
                <input
                  type="checkbox"
                  name="dept"
                  value={d.code}
                  defaultChecked
                  className="size-5"
                />
                <span>
                  {d.name}
                  {d.store && (
                    <span className="text-sm text-slate-500"> · keeps the {d.store}</span>
                  )}
                  {d.note && <span className="block text-sm text-slate-500">{d.note}</span>}
                </span>
              </label>
            ))}
            {plan.offered.map((d, n) => (
              <div key={d.code}>
                {d.alsoIn && plan.offered.findIndex((o) => o.alsoIn) === n && (
                  <p className="pt-2 text-sm font-medium text-slate-600">
                    Also in a {d.alsoIn === 'restaurant' ? 'restaurant' : 'café'}
                  </p>
                )}
                <label className="flex min-h-12 items-center gap-3 rounded-lg bg-white px-3 ring-1 ring-slate-200">
                  <input type="checkbox" name="dept" value={d.code} className="size-5" />
                  <span>
                    {d.name}
                    {d.note && <span className="block text-sm text-slate-500">{d.note}</span>}
                  </span>
                </label>
              </div>
            ))}
          </fieldset>
        )}
        <label className="flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            name="items"
            value="yes"
            defaultChecked={choice.items !== false}
            className="size-5"
          />
          Starter stock items (names and units; you add par and prices)
        </label>
        <button type="submit" className={secondaryButton}>
          See what it adds
        </button>
      </form>

      {review && plan && !error && (
        <section
          className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200"
          data-testid="review"
        >
          <h2 className="text-lg font-semibold">{choice.name} adds</h2>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="font-medium">Departments and stores</dt>
              <dd>
                {plan.departments
                  .map((d) => (d.store ? `${d.name} (${d.store})` : d.name))
                  .join(', ')}
              </dd>
            </div>
            <div>
              <dt className="font-medium">People it expects ({plan.roles.length} roles)</dt>
              <dd>{plan.roles.map((r) => r.title).join(', ')}</dd>
            </div>
            <div>
              <dt className="font-medium">Starter checklists</dt>
              <dd>
                {plan.checklists
                  .map((c) => {
                    // who does it (ADR 075): its role here, else whoever is on shift
                    const role = plan.roles.find((r) => `role:${r.code}` === c.assignTo);
                    return `${c.name} (${role ? role.title : 'whoever is on shift'})`;
                  })
                  .join(', ') || 'none'}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Starter items</dt>
              <dd>{plan.items.length ? `${plan.items.length} items` : 'none'}</dd>
            </div>
            {plan.centralKitchen && (
              <div>
                <dt className="font-medium">Central kitchen</dt>
                <dd>A central kitchen beside it, with its own store</dd>
              </div>
            )}
          </dl>
          {missingBundleNotes(plan.modules, inPlan).length > 0 && (
            <ul
              className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
              data-testid="bundle-notes"
            >
              {missingBundleNotes(plan.modules, inPlan).map((n) => (
                <li key={n}>{n}. Turn it on in Bundles on the customer&apos;s page.</li>
              ))}
            </ul>
          )}
          <p className="text-sm text-slate-600">
            Next: we check the customer&apos;s files with this outlet added. Nothing changes until
            you load it. Its people are added afterwards, by their files or in the app.
          </p>
          <form method="post" action={`/platform/customers/${id}/add-outlet/submit`}>
            <input type="hidden" name="tile" value={choice.tile} />
            <input type="hidden" name="x" value="1" />
            {choice.extras.map((x) => (
              <input key={x} type="hidden" name="extra" value={x} />
            ))}
            <input type="hidden" name="d" value="1" />
            {plan.departments.map((d) => (
              <input key={d.code} type="hidden" name="dept" value={d.code} />
            ))}
            <input type="hidden" name="name" value={choice.name} />
            <input type="hidden" name="under" value={choice.parentCode} />
            <input type="hidden" name="items" value={choice.items === false ? 'no' : 'yes'} />
            <button type="submit" className={primaryButton}>
              Add and check
            </button>
          </form>
        </section>
      )}
    </>
  );
}
