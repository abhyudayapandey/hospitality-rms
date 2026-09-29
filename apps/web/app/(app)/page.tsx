import Link from 'next/link';
import { isDevAuthEnabled } from '@/lib/dev-auth';
import { loadShell } from '@/lib/shell';

export default async function Home() {
  const shell = await loadShell();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Hello, {shell.user.name.split(' ')[0]}</h1>
      {shell.currentNode && (
        <p className="text-sm text-slate-600">
          Working at <strong>{shell.currentNode.name}</strong>
        </p>
      )}
      <Link
        href="/inbox"
        className="flex min-h-16 items-center justify-between rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
      >
        <span className="font-medium">Waiting for you</span>
        <span className="text-2xl font-semibold" data-testid="inbox-count">
          {shell.inboxCount}
        </span>
      </Link>
      <Link
        href="/requests"
        className="flex min-h-16 items-center rounded-xl bg-white p-4 font-medium shadow-sm ring-1 ring-slate-200"
      >
        My requests
      </Link>
      {isDevAuthEnabled() && (
        <Link
          href="/requests/new"
          className="flex min-h-12 items-center justify-center rounded-xl border border-dashed border-slate-400 p-3 text-sm text-slate-600"
        >
          New test request (dev only)
        </Link>
      )}
    </div>
  );
}
