'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ALWAYS_ON, BUNDLES, MODULES, needsOf } from '@outlet-ops/domain';
import { ErrorBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { setBundle, setModule } from '../../actions';

/** One block of the customer, as platform.customer_modules returns it. */
export interface CustomerModule {
  bundle: string;
  module: string;
  in_plan: boolean;
  /** switched on (or on by default) */
  switched_on: boolean;
  /** on: switched on, its bundle in the plan and every block it needs on */
  is_on: boolean;
}

const nameOf = (code: string) => MODULES.find((m) => m.code === code)?.name ?? code;

/**
 * What the customer buys (ADR 067, 085): a card per bundle with the switch that puts it in or
 * out of the plan, and inside it a switch per block. Only here: nobody in the customer changes
 * either; Admin → Your plan shows them read-only.
 */
export function Bundles({
  tenantId,
  customer,
  modules,
}: {
  tenantId: string;
  customer: string;
  modules: CustomerModule[];
}) {
  const of = new Map(modules.map((m) => [m.module, m]));
  return (
    <section className="space-y-2" aria-label="What they buy">
      <h2 className="font-semibold">What they buy</h2>
      <p className="text-sm text-slate-600">{ALWAYS_ON}</p>
      <div className="space-y-3" data-testid="bundles">
        {BUNDLES.map((b) => {
          const inPlan = b.modules.some((m) => of.get(m)?.in_plan);
          return (
            <section
              key={b.code}
              aria-label={b.name}
              data-bundle={b.code}
              className="rounded-xl bg-white text-sm ring-1 ring-slate-200"
            >
              <div className="flex items-start justify-between gap-3 p-3">
                <span className="min-w-0">
                  <span className="block font-medium">{b.name}</span>
                  <span className="block text-xs text-slate-500">{b.adds}</span>
                </span>
                <Switch
                  label={b.name}
                  on={inPlan}
                  confirmText={`Every part of it stops for everyone at ${customer}. Nothing is deleted.`}
                  save={(next) => setBundle(tenantId, b.code, next)}
                />
              </div>
              {inPlan && (
                <ul className="divide-y divide-slate-200 border-t border-slate-200">
                  {b.modules.map((code) => {
                    const m = of.get(code);
                    const switched = m?.switched_on ?? false;
                    const missing = needsOf(code).filter((n) => !of.get(n)?.is_on);
                    return (
                      <li
                        key={code}
                        className="flex items-start justify-between gap-3 p-3 pl-5"
                        data-module={code}
                      >
                        <span className="min-w-0">
                          <span className="block">{nameOf(code)}</span>
                          <span className="block text-xs text-slate-500">
                            {MODULES.find((x) => x.code === code)?.what}
                          </span>
                          {switched && missing.length > 0 && (
                            <span className="block text-xs text-amber-800" data-testid="needs">
                              Off until {missing.map(nameOf).join(' and ')} is on
                            </span>
                          )}
                        </span>
                        <Switch
                          label={nameOf(code)}
                          on={switched}
                          confirmText={`It stops for everyone at ${customer}. Nothing is deleted.`}
                          save={(next) => setModule(tenantId, code, next)}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

/** On or off; turning off asks first, since it stops it for everyone there. */
function Switch({
  label,
  on,
  confirmText,
  save: write,
}: {
  label: string;
  on: boolean;
  confirmText: string;
  save: (next: boolean) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (next: boolean) =>
    start(async () => {
      const r = await write(next);
      setConfirm(false);
      if (!r.ok) setError(r.message);
      else {
        setError(null);
        router.refresh();
      }
    });
  const button = 'min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium disabled:opacity-50';
  if (confirm) {
    return (
      <div role="group" aria-label={`Turn off ${label}`} className="flex shrink-0 flex-col gap-2">
        <p className="max-w-40 text-xs text-slate-600">{confirmText}</p>
        <button
          type="button"
          className={`${button} ring-1 ring-slate-300`}
          onClick={() => setConfirm(false)}
        >
          Keep on
        </button>
        <button
          type="button"
          disabled={pending}
          className={`${button} bg-rose-700 text-white`}
          onClick={() => save(false)}
        >
          Turn off
        </button>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={!hydrated || pending}
        onClick={() => (on ? setConfirm(true) : save(true))}
        className={`${button} ${on ? 'bg-emerald-700 text-white' : 'ring-1 ring-slate-300'}`}
      >
        {on ? 'On' : 'Off'}
      </button>
      <ErrorBox message={error} />
    </div>
  );
}
