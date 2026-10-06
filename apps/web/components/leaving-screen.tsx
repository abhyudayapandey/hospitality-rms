/**
 * Covers the app the moment someone signs out (ADR 056): the last screen never stays up
 * while the session is cleared and the sign-in page loads.
 */
export function LeavingScreen({ text = 'Signing you out…' }: { text?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="leaving"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-slate-50"
    >
      <span
        aria-hidden="true"
        className="size-10 animate-spin rounded-full border-4 border-slate-200 border-t-brand-700"
      />
      <p className="text-base font-medium text-slate-700">{text}</p>
    </div>
  );
}

/** Service-worker caches, cleared on the phone before leaving (ADR 004). */
export async function clearCaches(): Promise<void> {
  if (!('caches' in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
}
