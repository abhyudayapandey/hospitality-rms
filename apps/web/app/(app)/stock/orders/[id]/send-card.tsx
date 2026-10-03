'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox } from '@/components/messages';
import { recordPoSend } from '../../actions';

export interface Sent {
  channel: 'whatsapp' | 'email' | 'print';
  by: string;
  at: string;
}

/**
 * Send a released order to its supplier (PO-4, ADR 032): each button records the send, then
 * opens WhatsApp, the mail app or the printable order on this phone. Nothing is sent from the
 * server; what the person sends from their own app is up to them.
 */
export function SendCard({
  po,
  whatsapp,
  mailto,
  sent,
}: {
  po: string;
  whatsapp: string | null;
  mailto: string | null;
  sent: { channel: Sent['channel']; label: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const send = (channel: Sent['channel'], url: string) =>
    start(async () => {
      const r = await recordPoSend(po, channel);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setError(null);
      if (channel === 'print') router.push(url);
      else window.location.assign(url);
    });
  const button =
    'flex min-h-12 flex-1 items-center justify-center rounded-lg px-3 text-sm font-medium ring-1 ring-slate-300 disabled:opacity-50';
  return (
    <section aria-label="Send to supplier" className="space-y-2" data-testid="send-card">
      <h2 className="text-sm font-semibold text-slate-700">Send to supplier</h2>
      <div className="flex flex-wrap gap-2">
        {whatsapp && (
          <button
            type="button"
            disabled={pending}
            className={`${button} bg-emerald-700 text-white ring-0`}
            data-href={whatsapp}
            onClick={() => send('whatsapp', whatsapp)}
          >
            WhatsApp
          </button>
        )}
        {mailto && (
          <button
            type="button"
            disabled={pending}
            className={button}
            data-href={mailto}
            onClick={() => send('email', mailto)}
          >
            Email
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          className={button}
          onClick={() => send('print', `/stock/orders/${po}/print`)}
        >
          Print
        </button>
      </div>
      {!whatsapp && !mailto && (
        <p className="text-sm text-slate-600">
          No phone or email for this supplier yet. Add one below to send from here.
        </p>
      )}
      <ErrorBox message={error} />
      {sent.length > 0 && (
        <ul className="space-y-1 text-sm text-slate-600" data-testid="sends">
          {sent.map((s, i) => (
            <li key={i}>{s.label}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
