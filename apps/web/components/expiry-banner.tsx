import Link from 'next/link';
import { EXPIRY_TITLE, type ExpiryShow } from '@/lib/expiry';
import { Icon } from './icon';

/** "Items expiring within 3 days" (amber) and "Expired items" (red), opening their tab of Stock. */
export function ExpiryBanner({ show, n, href }: { show: ExpiryShow; n: number; href: string }) {
  const tone =
    show === 'expired'
      ? 'bg-rose-50 text-rose-900 ring-rose-200'
      : 'bg-amber-50 text-amber-900 ring-amber-200';
  return (
    <Link
      href={href}
      className={`flex min-h-14 items-center gap-3 rounded-xl px-4 py-2 ring-1 ${tone}`}
      data-testid={`banner-${show}`}
    >
      <Icon name={show === 'expired' ? 'alert' : 'clock'} />
      <span className="flex-1 font-medium">{EXPIRY_TITLE[show]}</span>
      <span className="text-lg font-semibold tabular-nums">{n}</span>
      <Icon name="chevron" className="size-5" />
    </Link>
  );
}
