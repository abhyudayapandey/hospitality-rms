import { redirect } from 'next/navigation';
import { param, type SearchParams } from '@/lib/inventory';
import { isUuid } from '@/lib/params';
import { stockHref, stockTab } from '@/lib/stock-view';

// Expiring and expired stock are tabs of the Stock screen (ADR 048). This address stays for
// the push links and notifications already sent, and sends them there.
export default async function ExpiryRedirect({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const tab = stockTab({ show: param(sp, 'show') });
  const node = param(sp, 'node');
  redirect(
    stockHref({
      tab: tab === 'all' ? 'expiring' : tab,
      all: param(sp, 'all') === '1',
      node: isUuid(node) ? node : null,
    }),
  );
}
