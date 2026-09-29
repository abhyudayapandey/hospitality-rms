'use client';

import { useEffect } from 'react';

/** Registers /sw.js (installable PWA, offline page). */
export function ServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch(() => {
          // Not fatal: the app works without it.
        });
    }
  }, []);
  return null;
}
