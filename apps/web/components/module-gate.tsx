import Link from 'next/link';
import type { ModuleCode } from '@outlet-ops/domain';
import { bundleOf, MODULES } from '@outlet-ops/domain';
import { sql, withUser } from '@/lib/db';
import { loadShell } from '@/lib/shell';
import { Empty } from './messages';

/**
 * A block's screens when the customer doesn't have it on (ADR 026, 085): the page says so
 * instead of showing the screen. The data is kept; only Outlet Ops switches blocks and bundles.
 */
export async function ModuleGate({
  code,
  children,
}: {
  code: ModuleCode;
  children: React.ReactNode;
}) {
  const shell = await loadShell();
  if (shell.modules.has(code)) return children;
  // out of the plan (ADR 067, 085)
  const bundle = bundleOf(code);
  const inPlan = await withUser(shell.user.id, async (tx) => {
    const r = await sql<{ in_plan: boolean }>`
      select in_plan from core.my_bundles() where code = ${bundle.code}`.execute(tx);
    return r.rows[0]?.in_plan ?? true;
  });
  return <ModuleOff code={code} plan={inPlan ? null : bundle.name} />;
}

export function ModuleOff({ code, plan = null }: { code: ModuleCode; plan?: string | null }) {
  const name = MODULES.find((m) => m.code === code)!.name;
  return (
    <div className="space-y-3" data-testid="module-off">
      <h1 className="text-xl font-semibold">{name}</h1>
      <Empty>
        {plan
          ? `${plan} isn't part of your company's plan. Ask Outlet Ops to add it.`
          : `${name} isn't switched on for your company. Ask Outlet Ops to switch it on.`}
      </Empty>
      <Link href="/" className="block text-sm text-slate-700 underline">
        Back to Home
      </Link>
    </div>
  );
}
