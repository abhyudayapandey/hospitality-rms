import Link from 'next/link';
import { MODULES } from '@outlet-ops/domain';
import { loadShell } from '@/lib/shell';
import { ModuleSwitch } from './module-switch';

// Modules (ADR 026): what the company uses. A module that is off disappears from every
// screen and refuses its writes; its data is kept. Only the Account Owner changes them
// (COMPANY_SETTINGS modify, checked by core.set_module); other administrators see them.
export default async function ModulesPage() {
  const shell = await loadShell();
  if (!shell.domains.has('USER_ACCESS') && !shell.domains.has('COMPANY_SETTINGS')) {
    return <p className="text-slate-700">You don&apos;t have access to administration.</p>;
  }
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
      <ul
        className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200"
        data-testid="modules"
      >
        {MODULES.map((m) => {
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
              {owner && !blocked ? (
                <ModuleSwitch code={m.code} name={m.name} on={on} />
              ) : (
                <span className="shrink-0 text-sm text-slate-600" data-testid="module-state">
                  {on ? 'On' : 'Off'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
