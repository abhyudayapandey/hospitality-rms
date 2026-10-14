'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icon';
import { primaryButton, secondaryButton } from '@/components/messages';

// When a screen can't open (it isn't yours to see, it has moved, or the server failed): say so
// in plain words with a way back, never a bare error page (ADR 142).
export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  return (
    <div className="space-y-4 py-6 text-center" data-testid="page-problem">
      <Icon name="alert" className="mx-auto size-10 text-amber-700" />
      <h1 className="text-lg font-semibold">We couldn’t open this</h1>
      <p className="text-sm text-slate-600">
        It may not be yours to see, or it may have changed. Go back, or try again.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={secondaryButton} onClick={() => router.back()}>
          Go back
        </button>
        <button type="button" className={primaryButton} onClick={() => reset()}>
          Try again
        </button>
      </div>
      <Link href="/" className="block text-sm font-medium text-brand-700 underline">
        Home
      </Link>
    </div>
  );
}
