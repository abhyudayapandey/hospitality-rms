'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton } from '@/components/messages';
import { offerSwap } from '../../actions';

export function OfferForm({
  assignment,
  colleagues,
}: {
  assignment: string;
  colleagues: { worker_id: string; display_name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [to, setTo] = useState(colleagues[0]?.worker_id ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await offerSwap(assignment, to, note);
          if (!r.ok) setError(r.message);
          else router.push('/roster/swaps');
        });
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Who takes it?</legend>
        {colleagues.map((c) => (
          <label
            key={c.worker_id}
            className="flex min-h-12 items-center gap-3 rounded-xl bg-white px-4 ring-1 ring-slate-200"
          >
            <input
              type="radio"
              name="to"
              value={c.worker_id}
              checked={to === c.worker_id}
              onChange={() => setTo(c.worker_id)}
              className="size-5"
            />
            {c.display_name}
          </label>
        ))}
      </fieldset>
      <label className="block text-sm">
        Note (optional)
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          className={inputClass}
        />
      </label>
      <button type="submit" disabled={pending || !to} className={primaryButton}>
        Send offer
      </button>
      <ErrorBox message={error} />
    </form>
  );
}
