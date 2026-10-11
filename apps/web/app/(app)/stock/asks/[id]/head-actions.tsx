'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { actOnStaffAsk } from '../../actions';

/**
 * The department head (ADR 115): give it from the store (it leaves the store as given), ask
 * for it (the store is short: the outlet's chain), or say no, with why. Asked for already:
 * give it once it arrives.
 */
export function HeadActions({
  ask,
  status,
  short,
}: {
  ask: string;
  status: string;
  short: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saying, setSaying] = useState(false);
  const [why, setWhy] = useState('');
  const act = (action: 'give' | 'ask' | 'close') =>
    start(async () => {
      setError(null);
      if (action === 'close' && !why.trim()) {
        setError('Say why.');
        return;
      }
      const r = await actOnStaffAsk(ask, action, action === 'close' ? why : '');
      if (r.ok) router.refresh();
      else setError(r.message);
    });
  if (saying)
    return (
      <div className="space-y-2 rounded-xl bg-rose-50 p-3" data-testid="ask-no">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-rose-900">Why not?</span>
          <input
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            className={inputClass}
            placeholder="Enough in the room"
          />
        </label>
        <ErrorBox message={error} />
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setSaying(false)} className={secondaryButton}>
            Back
          </button>
          <button
            type="button"
            disabled={!hydrated || pending}
            onClick={() => act('close')}
            className="min-h-12 rounded-lg bg-rose-700 font-medium text-white disabled:opacity-50"
          >
            Can’t give it
          </button>
        </div>
      </div>
    );
  return (
    <section className="space-y-2" data-testid="head-actions">
      <ErrorBox message={error} />
      <button
        type="button"
        disabled={!hydrated || pending}
        onClick={() => act('give')}
        className={primaryButton}
      >
        {status === 'asked_on' ? 'It arrived: give it' : 'Give it'}
      </button>
      <div className="grid grid-cols-2 gap-2">
        {status === 'asked' && (
          <button
            type="button"
            disabled={!hydrated || pending}
            onClick={() => act('ask')}
            className={secondaryButton}
          >
            {short ? 'Short: ask for it' : 'Ask for it'}
          </button>
        )}
        <button type="button" onClick={() => setSaying(true)} className={secondaryButton}>
          Can’t give it
        </button>
      </div>
    </section>
  );
}
