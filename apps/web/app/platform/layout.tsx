import type { ReactNode } from 'react';

// The platform console (ADR 012): no customer shell, navigation or data.
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="flex items-center gap-2 border-b border-slate-200 pb-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed 32 px mark */}
        <img src="/icon.svg" alt="" width={32} height={32} className="size-8" />
        <p className="font-semibold">
          Hey Senior · Team console
          <span className="block text-xs font-normal text-slate-500">
            For Hey Senior staff: customers never see this
          </span>
        </p>
      </header>
      <main className="space-y-4">{children}</main>
    </div>
  );
}
