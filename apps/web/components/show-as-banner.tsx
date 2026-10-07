'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { backToMe } from '@/app/(app)/show-as/actions';
import { useHydrated } from '@/lib/use-hydrated';

/** On every screen while a demo presenter shows the app as someone (ADR 071). */
export function ShowAsBanner({ name, presenter }: { name: string; presenter: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  return (
    <div
      role="status"
      data-testid="show-as-banner"
      className="flex items-center justify-between gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-900 print:hidden"
    >
      <span className="min-w-0 truncate">
        Showing as <strong>{name}</strong>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <Link href="/show-as" className="font-medium underline">
          Switch
        </Link>
        <button
          type="button"
          disabled={!hydrated || pending}
          className="font-medium underline"
          onClick={() =>
            start(async () => {
              const r = await backToMe();
              if (r.ok) {
                router.push('/');
                router.refresh();
              }
            })
          }
        >
          Back to {presenter.split(' ')[0]}
        </button>
      </span>
    </div>
  );
}
