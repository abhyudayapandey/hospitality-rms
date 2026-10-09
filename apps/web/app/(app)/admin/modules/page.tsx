import Link from 'next/link';
import { ALWAYS_ON, BUNDLES, MODULES } from '@outlet-ops/domain';
import { requireUser } from '@/lib/auth/server';
import { sql, withUser } from '@/lib/db';
import { loadShell } from '@/lib/shell';

// The company's plan (ADR 026, 067, 085): its bundles and the blocks in each, read-only. Only
// Outlet Ops (platform admins) puts bundles in or out and switches blocks; nobody in the
// company changes them. Administrators see what they have.
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
  return (
    <div className="space-y-4">
      <Link href="/admin" className="text-sm text-slate-600">
        ← Administration
      </Link>
      <h1 className="text-xl font-semibold">Your plan</h1>
      <p className="text-sm text-slate-600">
        What your company has, in bundles. A part that is off isn&apos;t shown to anyone and nothing
        of it is deleted. To add or change anything, ask Outlet Ops.
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
                  {inPlan ? 'In your plan' : 'Not in your plan'}
                </span>
              </div>
              <p className="text-xs text-slate-500">{b.adds}</p>
              <ul className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200">
                {b.modules.map((code) => {
                  const m = MODULES.find((x) => x.code === code)!;
                  const on = shell.modules.has(m.code);
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
                      <span className="shrink-0 text-sm text-slate-600" data-testid="module-state">
                        {!inPlan ? 'Not in your plan' : on ? 'On' : 'Off'}
                      </span>
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
