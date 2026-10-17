import Link from 'next/link';
import { Icon } from '@/components/icon';
import { primaryButton } from '@/components/messages';

// An address that leads nowhere (ADR 169): the app's own words and a way Home, never the
// framework's bare 404.
export default function NotFound() {
  return (
    <main className="mx-auto max-w-md space-y-4 px-4 py-12 text-center" data-testid="not-found">
      <Icon name="alert" className="mx-auto size-10 text-amber-700" />
      <h1 className="text-lg font-semibold">We couldn’t find this</h1>
      <p className="text-sm text-slate-600">
        The link may be old, or what it showed was moved or removed.
      </p>
      <Link href="/" className={`${primaryButton} block`}>
        Home
      </Link>
    </main>
  );
}
