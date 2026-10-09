import Link from 'next/link';
import { ALWAYS_ON, EXTRA_BY_CODE, TILES, TILE_BY_CODE } from '@outlet-ops/domain';
import {
  COMPANY_ROLES,
  UNITS,
  companyCode,
  coverLines,
  customerCodeFrom,
  draftBundles,
  logins,
  outletPlan,
  roleChoices,
  roleQuestions,
  type DraftOutlet,
  type OutletPlan,
  type SetupDraft,
  type Step,
} from '@outlet-ops/onboarding/templates';
import { primaryButton, secondaryButton } from '@/components/messages';

// The wizard's first six screens (ADR 064). Plain forms posted to ../save; every field has a
// default, and what a person types is words, never codes.

const field = 'mt-1 block min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3';
const card = 'space-y-3 rounded-xl bg-white p-4 ring-1 ring-slate-200';

function Shell({
  id,
  step,
  children,
  label,
  next = true,
}: {
  id: string;
  step: Step;
  children: React.ReactNode;
  label: string;
  next?: boolean;
}) {
  return (
    <form
      method="post"
      action={`/platform/setup/${id}/save`}
      className="space-y-4"
      aria-label={label}
    >
      <input type="hidden" name="step" value={step} />
      {children}
      <div className="flex gap-2">
        {step !== 'company' && (
          <button type="submit" name="go" value="back" className={secondaryButton}>
            Back
          </button>
        )}
        {next && (
          <button type="submit" name="go" value="next" className={primaryButton}>
            Next
          </button>
        )}
      </div>
    </form>
  );
}

function plan(draft: SetupDraft, o: DraftOutlet): OutletPlan | null {
  try {
    return outletPlan(draft, o);
  } catch {
    return null;
  }
}

export function CompanyStep({ id, draft }: { id: string; draft: SetupDraft }) {
  const c = draft.company;
  return (
    <Shell id={id} step="company" label="Company">
      <label className="block text-sm font-medium">
        Company name
        <input
          name="name"
          required
          defaultValue={c.name}
          placeholder="Blue Bean Cafés"
          className={field}
        />
      </label>
      <label className="block text-sm font-medium">
        Short name for logins (letters, digits, dashes)
        <input
          name="code"
          defaultValue={c.code || (c.name ? customerCodeFrom(c.name) : '')}
          placeholder="Made from the company name"
          pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,19}"
          className={field}
        />
        <span className="text-xs text-slate-500">
          People without an email sign in as {companyCode(draft).toLowerCase() || 'blue-bean'}.ravi
        </span>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm font-medium">
          Country
          <input name="country" defaultValue={c.country} className={field} />
        </label>
        <label className="block text-sm font-medium">
          Currency
          <input name="currency" defaultValue={c.currency} className={field} />
        </label>
      </div>
      <label className="block text-sm font-medium">
        Time zone
        <input name="timezone" defaultValue={c.timezone} className={field} />
      </label>
      <fieldset className={card}>
        <legend className="px-1 font-semibold">The owner</legend>
        <p className="text-sm text-slate-600">
          They get an email invitation once the company is live, and set their own password.
        </p>
        <label className="block text-sm font-medium">
          Owner&apos;s name
          <input name="ownerName" defaultValue={c.ownerName} className={field} />
        </label>
        <label className="block text-sm font-medium">
          Owner&apos;s email
          <input name="ownerEmail" type="email" defaultValue={c.ownerEmail} className={field} />
        </label>
      </fieldset>
      <label className="flex min-h-12 items-center gap-3 text-sm">
        <input
          type="checkbox"
          name="isTest"
          value="yes"
          defaultChecked={c.isTest}
          className="size-5"
        />
        A demo or test company (can&apos;t be changed later)
      </label>
    </Shell>
  );
}

export function OutletsStep({
  id,
  draft,
  tile,
  edit,
  saved,
}: {
  id: string;
  draft: SetupDraft;
  /** A tile picked; '' to pick again; undefined when none was asked for. */
  tile: string | undefined;
  edit: string;
  saved: string;
}) {
  const editing = draft.outlets.find((o) => o.key === edit);
  const picked =
    tile !== undefined
      ? TILE_BY_CODE.get(tile)
      : editing
        ? TILE_BY_CODE.get(editing.tile)
        : undefined;
  const adding = !draft.outlets.length || tile !== undefined || editing;
  return (
    <>
      {draft.outlets.length > 0 && (
        <ul className="space-y-2" data-testid="outlets">
          {draft.outlets.map((o) => (
            <li
              key={o.key}
              className={`${card} ${o.key === saved ? 'ring-emerald-400' : ''}`}
              data-outlet={o.name}
            >
              <p className="font-medium">{o.name || 'No name yet'}</p>
              <p className="text-sm text-slate-600">
                {TILE_BY_CODE.get(o.tile)?.name}
                {o.extras.length > 0 &&
                  ` · with ${o.extras.map((x) => EXTRA_BY_CODE.get(x)!.name.toLowerCase()).join(', ')}`}
                {o.area && ` · ${o.area}`}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Link
                  href={`/platform/setup/${id}/outlets?edit=${o.key}`}
                  className={`${secondaryButton} flex items-center justify-center`}
                >
                  Change
                </Link>
                <form method="post" action={`/platform/setup/${id}/save`}>
                  <input type="hidden" name="step" value="outlets" />
                  <input type="hidden" name="op" value="remove" />
                  <input type="hidden" name="key" value={o.key} />
                  <button type="submit" className={secondaryButton} aria-label={`Remove ${o.name}`}>
                    Remove
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && !picked && (
        <section className="space-y-2">
          <h2 className="font-semibold">What is this outlet?</h2>
          <ul className="grid gap-2 sm:grid-cols-2" data-testid="tiles">
            {TILES.map((t) => (
              <li key={t.code}>
                <Link
                  href={`/platform/setup/${id}/outlets?tile=${t.code}${editing ? `&edit=${editing.key}` : ''}`}
                  className="flex min-h-16 flex-col justify-center rounded-xl bg-white p-3 ring-1 ring-slate-200"
                >
                  <span className="font-medium">{t.name}</span>
                  <span className="text-sm text-slate-600">{t.example}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {picked && (
        <form
          method="post"
          action={`/platform/setup/${id}/save`}
          className={card}
          aria-label="The outlet"
        >
          <input type="hidden" name="step" value="outlets" />
          <input type="hidden" name="op" value="save" />
          <input type="hidden" name="key" value={editing?.key ?? ''} />
          <input type="hidden" name="tile" value={picked.code} />
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-semibold">{picked.name}</p>
            <Link
              href={`/platform/setup/${id}/outlets?tile=${editing ? `&edit=${editing.key}` : ''}`}
              className="flex min-h-11 items-center text-sm underline"
            >
              Change type
            </Link>
          </div>
          <label className="block text-sm font-medium">
            Name
            <input
              name="name"
              required
              defaultValue={editing?.name}
              placeholder="Bandra Café"
              className={field}
            />
          </label>
          {picked.offers.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="font-medium">Anything else here?</legend>
              {picked.offers.map((x) => {
                const e = EXTRA_BY_CODE.get(x)!;
                const on =
                  editing && editing.tile === picked.code
                    ? editing.extras.includes(x)
                    : (picked.with ?? []).includes(x);
                return (
                  <label
                    key={x}
                    className="flex min-h-12 items-start gap-3 rounded-lg p-2 ring-1 ring-slate-200"
                  >
                    <input
                      type="checkbox"
                      name="extra"
                      value={x}
                      defaultChecked={on}
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
          <label className="block text-sm font-medium">
            Area (optional, when they have outlets in more than one city)
            <input
              name="area"
              defaultValue={editing?.area}
              placeholder="Mumbai"
              className={field}
            />
          </label>
          <label className="block text-sm font-medium">
            Where it is, for clock-in (optional): latitude, longitude from a map
            <input
              name="location"
              defaultValue={editing?.location}
              placeholder="19.0596, 72.8295"
              className={field}
            />
          </label>
          <label className="block text-sm font-medium">
            Clock-in works within (metres)
            <input
              name="radius"
              inputMode="numeric"
              defaultValue={editing?.radius || '150'}
              className={field}
            />
          </label>
          <button type="submit" name="go" value="stay" className={primaryButton}>
            Save outlet
          </button>
        </form>
      )}
      {draft.outlets.length > 0 && !adding && (
        <Link
          href={`/platform/setup/${id}/outlets?tile=`}
          className={secondaryButton}
          data-testid="add-outlet"
        >
          Add another outlet
        </Link>
      )}
      <Shell id={id} step="outlets" label="Outlets next" next={draft.outlets.length > 0}>
        {null}
      </Shell>
    </>
  );
}

/**
 * Screen 3, What they buy (ADR 067, 085): every bundle, those its outlets use first and
 * ticked, the rest after them unticked (Events & compliance among them). Untick what they aren't
 * buying; tick what they are. The next screens and the files follow it.
 */
export function BundlesStep({ id, draft }: { id: string; draft: SetupDraft }) {
  const bundles = draftBundles(draft);
  const usual = bundles.filter((b) => b.usual);
  const more = bundles.filter((b) => !b.usual);
  const row = (b: (typeof bundles)[number]) => (
    <label
      key={b.code}
      className="flex min-h-12 items-start gap-3 rounded-lg bg-white p-3 ring-1 ring-slate-200"
      data-bundle={b.name}
    >
      <input
        type="checkbox"
        name="bundle"
        value={b.code}
        defaultChecked={b.ticked}
        className="mt-1 size-5"
      />
      <span>
        <span className="block font-medium">{b.name}</span>
        <span className="block text-sm text-slate-600">
          {b.uses.length > 0 && `Used for ${b.uses.join(', ')}. `}
          {b.adds}
        </span>
      </span>
    </label>
  );
  return (
    <Shell id={id} step="bundles" label="What they buy">
      <p className="text-sm text-slate-600">{ALWAYS_ON}</p>
      {usual.length > 0 && (
        <fieldset className="space-y-2" data-testid="bundles-usual">
          <legend className="pb-1 font-semibold">Usual for these outlets</legend>
          {usual.map(row)}
        </fieldset>
      )}
      <fieldset className="space-y-2" data-testid="bundles-more">
        <legend className="pb-1 font-semibold">Also available</legend>
        {more.map(row)}
      </fieldset>
    </Shell>
  );
}

export function DepartmentsStep({ id, draft }: { id: string; draft: SetupDraft }) {
  return (
    <Shell id={id} step="departments" label="Departments">
      {draft.outlets.map((o) => {
        const p = plan(draft, o);
        if (!p) return null;
        const firstOther = p.offered.findIndex((d) => d.alsoIn);
        return (
          <fieldset key={o.key} className={card} data-testid={`departments-${o.name}`}>
            <legend className="px-1 font-semibold">{o.name}</legend>
            <input type="hidden" name={`d:${o.key}`} value="1" />
            {p.departments.map((d) => (
              <label key={d.code} className="flex min-h-12 items-center gap-3">
                <input
                  type="checkbox"
                  name={`dept:${o.key}`}
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
            {p.offered.map((d, n) => (
              <div key={d.code}>
                {n === firstOther && (
                  <p className="pt-2 text-sm font-medium text-slate-600">
                    Also in a {d.alsoIn === 'restaurant' ? 'restaurant' : 'café'}
                  </p>
                )}
                <label className="flex min-h-12 items-center gap-3">
                  <input type="checkbox" name={`dept:${o.key}`} value={d.code} className="size-5" />
                  <span>
                    {d.name}
                    {d.note && <span className="block text-sm text-slate-500">{d.note}</span>}
                  </span>
                </label>
              </div>
            ))}
            <label className="flex min-h-12 items-center gap-3 border-t border-slate-100 pt-2 text-sm">
              <input
                type="checkbox"
                name={`items:${o.key}`}
                value="yes"
                defaultChecked={o.items}
                className="size-5"
              />
              Starter stock items (names and units; par on the Stock screen)
            </label>
          </fieldset>
        );
      })}
    </Shell>
  );
}

const MODE_WORDS = {
  have: 'We have it',
  covered_by: 'Someone else does it',
  not_done: "We don't do this",
};

export function RolesStep({ id, draft }: { id: string; draft: SetupDraft }) {
  return (
    <Shell id={id} step="roles" label="Roles">
      <p className="text-sm text-slate-600">
        For each role: do they have someone? If not, who does that work, or is it not done here?
      </p>
      {draft.outlets.map((o) => {
        if (!plan(draft, o)) return null;
        const qs = roleQuestions(draft, o);
        const lines = coverLines(draft, o);
        return (
          <section key={o.key} className="space-y-2" data-testid={`roles-${o.name}`}>
            <h2 className="font-semibold">{o.name}</h2>
            {lines.length > 0 && (
              <ul className="space-y-1 rounded-lg bg-sky-50 p-3 text-sm" data-testid="what-moves">
                {lines.map((l) => (
                  <li key={l.role}>
                    {l.line}
                    {l.warning && (
                      <span className="block font-medium text-amber-800">{l.warning}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {qs.map((q) => (
              <fieldset key={q.code} className={card} data-role={q.title}>
                <legend className="px-1 font-medium">{q.title}</legend>
                <p className="text-xs text-slate-600">{q.does.join(' · ')}</p>
                {(['have', 'covered_by', 'not_done'] as const).map((m) => (
                  <label key={m} className="flex min-h-10 items-center gap-3 text-sm">
                    <input
                      type="radio"
                      name={`role:${o.key}:${q.code}`}
                      value={m}
                      defaultChecked={q.answer.mode === m}
                      className="size-5"
                    />
                    {MODE_WORDS[m]}
                  </label>
                ))}
                <label className="cover-by pl-8 text-sm">
                  Who does it instead
                  <select
                    name={`by:${o.key}:${q.code}`}
                    defaultValue={q.answer.mode === 'covered_by' ? q.answer.by : ''}
                    className={field}
                  >
                    <option value="">Pick a role</option>
                    {qs
                      .filter((x) => x.code !== q.code)
                      .map((x) => (
                        <option key={x.code} value={x.code}>
                          {x.title}
                        </option>
                      ))}
                  </select>
                </label>
              </fieldset>
            ))}
          </section>
        );
      })}
    </Shell>
  );
}

export function PeopleStep({ id, draft }: { id: string; draft: SetupDraft }) {
  const roles = roleChoices(draft);
  const companyCodes = new Set(COMPANY_ROLES.map((r) => r.code));
  const rows = [
    ...draft.people,
    ...Array.from({ length: 3 }, () => ({ name: '', email: '', role: '', outlet: '' })),
  ];
  const ids = logins(draft);
  const withEmail = draft.people.filter((p) => p.email).length;
  return (
    <Shell id={id} step="people" label="People">
      <p className="text-sm text-slate-600">
        Everyone who will use the app. With an email, they get an invitation; without one, they get
        a login ID (like {companyCode(draft).toLowerCase()}.ravi) on a sheet you print for the
        manager. Everyone sets their own password when they first sign in.
      </p>
      {draft.people.length > 0 && (
        <p className="text-sm font-medium" data-testid="login-summary">
          {withEmail} by email · {draft.people.length - withEmail} on the printed sheet
        </p>
      )}
      <input type="hidden" name="pn" value={rows.length} />
      <ol className="space-y-2">
        {rows.map((p, i) => (
          <li key={i} className={card} data-testid="person">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-sm font-medium">
                Name
                <input name={`p.${i}.name`} defaultValue={p.name} className={field} />
              </label>
              <label className="block text-sm font-medium">
                Email (optional)
                <input
                  name={`p.${i}.email`}
                  type="email"
                  defaultValue={p.email}
                  className={field}
                />
              </label>
              <label className="block text-sm font-medium">
                Role
                <select name={`p.${i}.role`} defaultValue={p.role} className={field}>
                  <option value="">Pick a role</option>
                  <optgroup label="At an outlet">
                    {roles
                      .filter((r) => !companyCodes.has(r.code))
                      .map((r) => (
                        <option key={r.code} value={r.code}>
                          {r.title}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="For the company">
                    {roles
                      .filter((r) => companyCodes.has(r.code))
                      .map((r) => (
                        <option key={r.code} value={r.code}>
                          {r.title}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </label>
              <label className="block text-sm font-medium">
                Works at
                <select name={`p.${i}.outlet`} defaultValue={p.outlet} className={field}>
                  <option value="">The company (no one outlet)</option>
                  {draft.outlets.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {i < draft.people.length && (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-600">
                  {p.email ? `Invitation to ${p.email}` : `Login ID ${ids[i]?.username}`}
                </span>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name={`p.${i}.remove`} value="yes" className="size-5" />
                  Remove
                </label>
              </div>
            )}
          </li>
        ))}
      </ol>
      <label className="block text-sm font-medium">
        Or paste from a sheet: one person a line, name, email, role, outlet
        <textarea
          name="paste"
          rows={5}
          placeholder={
            'Ravi Kumar, ravi@example.com, Barista, Bandra Café\nMeena, , Chef, Bandra Café'
          }
          className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-3"
        />
      </label>
      <button type="submit" name="go" value="stay" className={secondaryButton}>
        Save and add more
      </button>
    </Shell>
  );
}

export function StockStep({ id, draft }: { id: string; draft: SetupDraft }) {
  return (
    <Shell id={id} step="stock" label="Stock">
      <p className="text-sm text-slate-600">
        What each store keeps, and its par: how much it should have. Prices come later, from the
        first bills. Leave par blank if they don&apos;t know yet.
      </p>
      {draft.outlets.map((o) => {
        const p = plan(draft, o);
        if (!p) return null;
        const stores = p.departments.filter((d) => d.store);
        const own = [
          ...o.ownItems,
          ...Array.from({ length: 2 }, () => ({
            department: stores[0]?.code ?? '',
            name: '',
            unit: 'kg' as const,
            par: '',
          })),
        ];
        return (
          <section key={o.key} className="space-y-2" data-testid={`stock-${o.name}`}>
            <h2 className="font-semibold">{o.name}</h2>
            <input type="hidden" name={`st:${o.key}`} value="1" />
            {stores.length === 0 && <p className="text-sm text-slate-600">No stores here.</p>}
            {stores.map((d) => {
              const items = p.items.filter((i) => i.department === d.code);
              return (
                <fieldset key={d.code} className={card}>
                  <legend className="px-1 font-medium">{d.store}</legend>
                  {items.length === 0 && (
                    <p className="text-sm text-slate-600">No starter items.</p>
                  )}
                  {items.map((i) => {
                    const k = `${d.code}:${i.code}`;
                    const s = o.stock[k];
                    return (
                      <div key={k} className="flex items-center gap-3" data-item={i.name}>
                        <label className="flex min-h-12 flex-1 items-center gap-3 text-sm">
                          <input
                            type="checkbox"
                            name={`s:${o.key}:${k}`}
                            value="on"
                            defaultChecked={!s?.off}
                            className="size-5"
                          />
                          {i.name}
                        </label>
                        <label className="flex items-center gap-1 text-sm">
                          Par
                          <input
                            name={`par:${o.key}:${k}`}
                            inputMode="decimal"
                            defaultValue={s?.par}
                            aria-label={`Par for ${i.name}`}
                            className="min-h-12 w-20 rounded-lg border border-slate-300 px-2"
                          />
                          {i.unit}
                        </label>
                      </div>
                    );
                  })}
                </fieldset>
              );
            })}
            {stores.length > 0 && (
              <fieldset className={card}>
                <legend className="px-1 font-medium">Their own items</legend>
                <input type="hidden" name={`ownn:${o.key}`} value={own.length} />
                {own.map((i, n) => (
                  <div key={n} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <input
                      name={`own:${o.key}:${n}.name`}
                      defaultValue={i.name}
                      placeholder="Item name"
                      aria-label="Item name"
                      className={`${field} col-span-2 sm:col-span-1`}
                    />
                    <select
                      name={`own:${o.key}:${n}.dept`}
                      defaultValue={i.department}
                      aria-label="Store"
                      className={field}
                    >
                      {stores.map((d) => (
                        <option key={d.code} value={d.code}>
                          {d.store}
                        </option>
                      ))}
                    </select>
                    <select
                      name={`own:${o.key}:${n}.unit`}
                      defaultValue={i.unit}
                      aria-label="Unit"
                      className={field}
                    >
                      {UNITS.map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </select>
                    <input
                      name={`own:${o.key}:${n}.par`}
                      defaultValue={i.par}
                      inputMode="decimal"
                      placeholder="Par"
                      aria-label="Par"
                      className={field}
                    />
                  </div>
                ))}
                <button type="submit" name="go" value="stay" className={secondaryButton}>
                  Save and add more
                </button>
              </fieldset>
            )}
          </section>
        );
      })}
    </Shell>
  );
}
