'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Tap feedback while a screen loads (ADR 055): a thin bar at the top and the tapped link
 * dimmed (`data-pending`) until the screen's skeleton is up (it carries the bar on), and a
 * second tap on the same link ignored, so a slow network never looks like a missed tap.
 * Cleared when the new screen arrives, or after 20 s.
 */
export function NavProgress() {
  const path = usePathname();
  const search = useSearchParams();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setPending(false);
    for (const a of document.querySelectorAll('a[data-pending]')) a.removeAttribute('data-pending');
  }, [path, search]);

  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(false), 20_000);
    return () => clearTimeout(t);
  }, [pending]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;
      const to = new URL(a.href, location.href);
      if (to.origin !== location.origin) return;
      if (to.pathname === location.pathname && to.search === location.search) {
        // tapped again while this screen is still loading (its skeleton is up): ignore it
        if (document.querySelector('[data-testid="page-loading"]')) e.preventDefault();
        return;
      }
      if (a.hasAttribute('data-pending')) {
        // already on its way: a second tap would only start it again
        e.preventDefault();
        return;
      }
      if (e.defaultPrevented) return;
      a.setAttribute('data-pending', '');
      setPending(true);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  if (!pending) return null;
  return (
    <div
      data-testid="nav-progress"
      aria-hidden="true"
      className="nav-progress fixed inset-x-0 top-0 z-50 h-1 overflow-hidden"
    />
  );
}
