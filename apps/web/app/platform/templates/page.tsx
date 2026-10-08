import Link from 'next/link';
import {
  CHECKLIST_BY_CODE,
  DEPARTMENTS,
  EXTRA_BY_CODE,
  ROLE_BY_CODE,
  TEMPLATE_BY_FORMAT,
  TILES,
  inView,
} from '@outlet-ops/domain';
import { requirePlatformAdmin } from '@/lib/platform/server';

// Outlet templates, read-only (ADR 062): what each kind of outlet starts with, in plain words,
// for demos and for the onboarding team. Nothing here is a code they need to know.
export default async function TemplatesPage() {
  await requirePlatformAdmin();
  const dept = new Map(DEPARTMENTS.map((d) => [d.code, d.name]));
  return (
    <>
      <Link href="/platform" className="text-sm text-slate-600">
        ← Customers
      </Link>
      <h1 className="text-xl font-semibold">Kinds of outlet</h1>
      <p className="text-sm text-slate-600">
        What a new outlet starts with. Everything can be changed when it is added, and later.
      </p>
      {TILES.map((tile) => {
        const t = TEMPLATE_BY_FORMAT.get(tile.format)!;
        const departments = t.departments.filter((d) => d.on !== false && inView(d, tile.view));
        const on = new Set(departments.map((d) => d.code));
        const roles = t.roles.filter((r) => inView(r, tile.view));
        const lists = t.checklists.filter((c) => inView(c, tile.view));
        return (
          <section
            key={tile.code}
            data-testid={`template-${tile.code}`}
            className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200"
          >
            <h2 className="text-lg font-semibold">{tile.name}</h2>
            <p className="text-sm text-slate-600">{tile.example}</p>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="font-medium">Departments</dt>
                <dd>{departments.map((d) => dept.get(d.code)).join(', ')}</dd>
              </div>
              <div>
                <dt className="font-medium">People it expects</dt>
                <dd>
                  {[
                    ...new Set(
                      roles
                        .filter((r) => {
                          const home = r.department ?? ROLE_BY_CODE.get(r.code)!.home;
                          return home.startsWith('(') || on.has(home);
                        })
                        .map((r) => ROLE_BY_CODE.get(r.code)!.title),
                    ),
                  ].join(', ')}
                </dd>
              </div>
              <div>
                <dt className="font-medium">Starter checklists</dt>
                <dd>
                  {[...new Set(lists.map((c) => CHECKLIST_BY_CODE.get(c.code)!.name))].join(', ')}
                </dd>
              </div>
              <div>
                <dt className="font-medium">Can also have</dt>
                <dd>{tile.offers.map((x) => EXTRA_BY_CODE.get(x)!.name).join(', ')}</dd>
              </div>
            </dl>
          </section>
        );
      })}
    </>
  );
}
