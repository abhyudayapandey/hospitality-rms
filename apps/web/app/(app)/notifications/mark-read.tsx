'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { markRead } from '../roster/actions';

export function MarkAllRead() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await markRead(null);
          router.refresh();
        })
      }
      className="min-h-11 rounded-lg px-3 text-sm font-medium ring-1 ring-slate-300 disabled:opacity-50"
    >
      Mark all read
    </button>
  );
}
