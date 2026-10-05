import Link from 'next/link';

/** The next page of a long list (ADR 052). */
export function ShowMore({ href }: { href: string }) {
  return (
    <Link
      href={href}
      scroll={false}
      data-testid="show-more"
      className="flex min-h-11 items-center justify-center text-sm font-medium text-brand-700 underline"
    >
      Show more
    </Link>
  );
}
