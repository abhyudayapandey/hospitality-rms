// What a screen shows the moment it is tapped, while the server builds it (ADR 055): the
// shape of a title, a row of tabs and a list. Every (app) screen's loading.tsx is this.
export default function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" data-testid="page-loading">
      <span className="sr-only">Loading…</span>
      {/* the top bar stays until the screen is in */}
      <div
        aria-hidden="true"
        className="nav-progress fixed inset-x-0 top-0 z-50 h-1 overflow-hidden"
      />
      <div className="h-7 w-2/3 animate-pulse rounded-lg bg-slate-200" />
      <div className="flex gap-2">
        {[16, 20, 24, 16].map((w, i) => (
          <div
            key={i}
            className="h-11 animate-pulse rounded-full bg-slate-200"
            style={{ width: `${w * 4}px` }}
          />
        ))}
      </div>
      <div className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex-1 space-y-2">
              <div className="h-4 w-3/5 animate-pulse rounded bg-slate-200" />
              <div className="h-3 w-2/5 animate-pulse rounded bg-slate-100" />
            </div>
            <div className="h-5 w-14 animate-pulse rounded bg-slate-200" />
          </div>
        ))}
      </div>
    </div>
  );
}
