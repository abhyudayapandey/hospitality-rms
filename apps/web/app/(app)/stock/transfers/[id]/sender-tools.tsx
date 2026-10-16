'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox, secondaryButton, StatusBox } from '@/components/messages';
import { Initials } from '@/components/initials';
import { useHydrated } from '@/lib/use-hydrated';
import { giveSend, orderForRequest } from '../../actions';

/**
 * Whoever runs the store, besides sending it themselves (ADR 115): give it to someone of the
 * team, who gets it as a task and says what they took; or, short, buy the rest from a
 * supplier for this request, approved as the outlet's rules say. Whoever asked follows both.
 */
export function SenderTools({
  transfer,
  people,
  givenTo,
}: {
  transfer: string;
  people: { id: string; name: string; on_shift: boolean }[];
  givenTo: string | null;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const give = (p: { id: string; name: string }) =>
    start(async () => {
      setError(null);
      const r = await giveSend(transfer, p.id);
      if (!r.ok) setError(r.message);
      else {
        setDone(`Given to ${p.name}. It is in their To do list.`);
        setPicking(false);
        router.refresh();
      }
    });
  const order = () =>
    start(async () => {
      setError(null);
      const r = await orderForRequest(transfer);
      if (!r.ok) setError(r.message);
      else router.push(`/stock/orders/${r.data.id}`);
    });

  return (
    <section className="space-y-2" data-testid="sender-tools">
      {givenTo && (
        <p className="text-sm text-slate-600" data-testid="given-to">
          Given to {givenTo} to bring. Give it to someone else, or send it yourself above.
        </p>
      )}
      {picking ? (
        <div className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <p className="text-sm font-medium">Who brings it?</p>
          {/* on shift today first (ADR 110, 142) */}
          {[
            ['On shift today', people.filter((p) => p.on_shift)] as const,
            ['Not on shift today', people.filter((p) => !p.on_shift)] as const,
          ]
            .filter(([, list]) => list.length > 0)
            .map(([title, list]) => (
              <div key={title} className="space-y-1">
                <p className="text-xs text-slate-500">{title}</p>
                <ul className="grid grid-cols-2 gap-2">
                  {list.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        disabled={!hydrated || pending}
                        onClick={() => give(p)}
                        className="h-full flex min-h-12 w-full items-center gap-2 rounded-lg bg-slate-50 p-2 text-left text-sm ring-1 ring-slate-200"
                      >
                        <Initials name={p.name} />
                        <span className="min-w-0 truncate">{p.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          <button type="button" onClick={() => setPicking(false)} className={secondaryButton}>
            Not now
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!hydrated || pending || people.length === 0}
            onClick={() => setPicking(true)}
            className={secondaryButton}
          >
            Give to someone
          </button>
          <button
            type="button"
            disabled={!hydrated || pending}
            onClick={order}
            className={secondaryButton}
          >
            Buy what’s short
          </button>
        </div>
      )}
      <ErrorBox message={error} />
      <StatusBox message={done} />
    </section>
  );
}
