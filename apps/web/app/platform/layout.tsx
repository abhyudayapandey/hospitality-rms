import type { ReactNode } from 'react';

// The platform console (ADR 012): no customer shell, navigation or data.
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="flex items-baseline justify-between gap-2 border-b border-slate-200 pb-2">
        <p className="font-semibold">Outlet Ops · Platform</p>
      </header>
      <main className="space-y-4">{children}</main>
    </div>
  );
}
