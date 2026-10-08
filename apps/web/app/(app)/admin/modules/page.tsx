import Link from 'next/link';
import { ALWAYS_ON, BUNDLES, MODULES } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { loadShell } from '@/lib/shell';
import { ModuleSwitch } from './module-switch';

// Modules (ADR 026) by bundle (ADR 067): what the company uses. Bundles are what the company
// buys, so this page shows them read-only: "On" or "Not in your plan". Inside a bundle that
// is on, the Account Owner turns single modules off and on (COMPANY_SETTINGS modify, checked
// by core.set_module, which refuses one outside the plan); other administrators see them.
export default async function ModulesPage() {
  const shell = await loadShell();
  if (!shell.domains.has('USER_ACCESS') && !shell.domains.has('COMPANY_SETTINGS')) {
    return <p className="text-slate-700">You don&apos;t have access to administration.</p>;
  }
  const user = await requireUser();
  const plan = new Set(
    (
      await withUser(user.id, (tx) =>
        sql<{
          code: string;
          in_plan: boolean;
        }>`select code, in_plan from core.my_bundles()`.execute(tx),
      )
    ).rows
      .filter((b) => b.in_plan)
      .map((b) => b.code),
  );
  const owner = shell.domains.get('COMPANY_SETTINGS') === 'modify';
  return (
    <div className="space-y-4">
      <Link href="/admin" className="text-sm text-slate-600">
        ← Administration
      </Link>
      <h1 className="text-xl font-semibold">Modules</h1>
      <p className="text-sm text-slate-600">
        A module that is off disappears for everyone in the company. Nothing is deleted: turn it
        back on and everything is there.
        {owner ? '' : ' Only the account owner can change these.'}
      </p>
      <p className="text-sm text-slate-600">{ALWAYS_ON}</p>
      <div className="space-y-4" data-testid="modules">
        {BUNDLES.map((b) => {
          const inPlan = plan.has(b.code);
          return (
            <section key={b.code} aria-label={b.name} data-bundle={b.code} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-semibold">{b.name}</h2>
                <span
                  className={`shrink-0 text-sm ${inPlan ? 'text-emerald-800' : 'text-slate-600'}`}
                  data-testid="bundle-state"
                >
                  {inPlan ? 'On' : 'Not in your plan'}
                </span>
              </div>
              <p className="text-xs text-slate-500">{b.adds}</p>
              <ul className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200">
                {b.modules.map((code) => {
                  const m = MODULES.find((x) => x.code === code)!;
                  const on = shell.modules.has(m.code);
                  const blocked = 'needs' in m && !shell.modules.has(m.needs);
                  return (
                    <li
                      key={m.code}
                      className="flex items-center justify-between gap-3 p-3"
                      data-module={m.code}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium">{m.name}</span>
                        <span className="block text-xs text-slate-500">{m.what}</span>
                      </span>
                      {owner && inPlan && !blocked ? (
                        <ModuleSwitch code={m.code} name={m.name} on={on} />
                      ) : (
                        <span
                          className="shrink-0 text-sm text-slate-600"
                          data-testid="module-state"
                        >
                          {!inPlan ? 'Not in your plan' : on ? 'On' : 'Off'}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
