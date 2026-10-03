'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox } from '@/components/messages';
import { updateSupplierContact } from '../../actions';

/** The supplier's phone (for WhatsApp) and email, kept by whoever runs the orders. */
export function ContactForm({
  supplier,
  phone,
  email,
}: {
  supplier: string;
  phone: string | null;
  email: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [p, setP] = useState(phone ?? '');
  const [e, setE] = useState(email ?? '');
  const save = (ev: React.FormEvent) => {
    ev.preventDefault();
    start(async () => {
      const r = await updateSupplierContact(supplier, p.trim(), e.trim());
      if (!r.ok) setError(r.message);
      else {
        setError(null);
        router.refresh();
      }
    });
  };
  const field = 'min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3';
  return (
    <details className="rounded-xl bg-white ring-1 ring-slate-200">
      <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium">
        Supplier contact
        <span className="block text-xs font-normal text-slate-500">
          {[phone, email].filter(Boolean).join(' · ') || 'none yet'}
        </span>
      </summary>
      <form onSubmit={save} className="space-y-3 border-t border-slate-100 p-4">
        <label className="block space-y-1">
          <span className="text-sm">Phone (WhatsApp)</span>
          <input
            id="supplier-phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            className={field}
            value={p}
            onChange={(x) => setP(x.target.value)}
            placeholder="+91 98200 10002"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">Email</span>
          <input
            id="supplier-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            className={field}
            value={e}
            onChange={(x) => setE(x.target.value)}
          />
        </label>
        <button
          disabled={pending}
          className="min-h-12 w-full rounded-lg bg-brand-700 font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save contact'}
        </button>
        <ErrorBox message={error} />
        <p className="text-xs text-slate-500">For every store that orders from this supplier.</p>
      </form>
    </details>
  );
}
