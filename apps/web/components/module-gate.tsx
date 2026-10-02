import Link from 'next/link';
import type { ModuleCode } from '@outlet-ops/domain';
import { MODULES } from '@outlet-ops/domain';
import { loadShell } from '@/lib/shell';
import { Empty } from './messages';

/**
 * A module's screens when the company has switched it off (ADR 026): the page says so
 * instead of showing the screen. The data is kept; the Account Owner can turn it back on in
 * Admin → Modules.
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
  return <ModuleOff code={code} />;
}

export function ModuleOff({ code }: { code: ModuleCode }) {
  const name = MODULES.find((m) => m.code === code)!.name;
  return (
    <div className="space-y-3" data-testid="module-off">
      <h1 className="text-xl font-semibold">{name}</h1>
      <Empty>
        {name} isn&apos;t switched on for your company. Your account owner can turn it on in Admin.
      </Empty>
      <Link href="/" className="block text-sm text-slate-700 underline">
        Back to Home
      </Link>
    </div>
  );
}
