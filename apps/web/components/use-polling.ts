'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { POLL_INTERVAL_MS, startPoller } from '@/lib/poller';

/** Re-fetches the current route's server data every 30 s while the page is visible. */
export function usePolling(intervalMs: number = POLL_INTERVAL_MS): void {
  const router = useRouter();
  useEffect(
    () =>
      startPoller(() => router.refresh(), intervalMs, {
        isVisible: () => document.visibilityState === 'visible',
        onVisibilityChange: (cb) => {
          document.addEventListener('visibilitychange', cb);
          return () => document.removeEventListener('visibilitychange', cb);
        },
      }),
    [router, intervalMs],
  );
}

export function PollRefresh() {
  usePolling();
  return null;
}
