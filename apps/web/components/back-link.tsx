'use client';

import { useRouter } from 'next/navigation';

/**
 * "← Back" for screens reached from more than one place (Menu from Reports, Home or Me):
 * goes back where the person came from, or to `fallback` when the screen was opened
 * directly (a new tab or a shared link has no history to go back to).
 */
export function BackLink({ fallback = '/' }: { fallback?: string }) {
  const router = useRouter();
  return (
    <a
      href={fallback}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (window.history.length > 1) {
          e.preventDefault();
          router.back();
        }
      }}
      className="inline-flex min-h-11 items-center text-sm text-slate-600 underline"
    >
      ← Back
    </a>
  );
}
