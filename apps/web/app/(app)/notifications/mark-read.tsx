'use client';

import { useRouter } from 'next/navigation';
import { useTransition, type ReactNode } from 'react';
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

/**
 * One notification line. Opening it marks it (or every notification of its group) read
 * first, then goes to its link; a line with no link is marked read where it stands.
 */
export function NotificationItem({
  ids,
  link,
  unread,
  className,
  children,
}: {
  ids: string[];
  link: string | null;
  unread: boolean;
  className: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const open = () =>
    start(async () => {
      if (unread) await markRead(ids);
      if (link) router.push(link);
      else router.refresh();
    });
  if (!link && !unread) return <div className={className}>{children}</div>;
  return (
    <a
      href={link ?? '#'}
      aria-busy={pending}
      onClick={(e) => {
        // a new tab or window keeps the browser's own behaviour
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open();
      }}
      className={`${className} ${pending ? 'opacity-60' : ''}`}
    >
      {children}
    </a>
  );
}
