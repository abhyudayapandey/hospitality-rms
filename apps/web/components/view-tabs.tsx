import Link from 'next/link';

/**
 * The tabs of one screen (ADR 048): the same list seen four, three or two ways, never another
 * screen; three sit in one row. Each link keeps the Place choice, built by the page.
 */
export function ViewTabs({
  label,
  tabs,
  current,
}: {
  label: string;
  tabs: readonly { key: string; label: string; count?: number; href: string }[];
  current: string;
}) {
  return (
    <nav
      aria-label={label}
      className={`grid ${tabs.length === 3 ? 'grid-cols-3' : 'grid-cols-2'} gap-1 rounded-lg bg-slate-100 p-1`}
    >
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? 'page' : undefined}
          data-testid={`tab-${t.key}`}
          className={`flex min-h-11 items-center justify-center rounded-md px-2 text-center text-sm ${
            t.key === current ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'
          }`}
        >
          {t.label}
          {t.count !== undefined ? ` (${t.count})` : ''}
        </Link>
      ))}
    </nav>
  );
}
