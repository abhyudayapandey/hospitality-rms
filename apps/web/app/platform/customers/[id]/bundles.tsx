'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ALWAYS_ON, BUNDLES, BUNDLE_STATE_WORDS, MODULES, bundleState } from '@outlet-ops/domain';
import { ErrorBox } from '@/components/messages';
import { useHydrated } from '@/lib/use-hydrated';
import { setBundle } from '../../actions';

/** One module of the customer, as platform.customer_modules returns it. */
export interface CustomerModule {
  bundle: string;
  module: string;
  in_plan: boolean;
  is_on: boolean;
}

const nameOf = (code: string) => MODULES.find((m) => m.code === code)?.name ?? code;

/**
 * What the customer buys (ADR 067): each bundle On, Partly on or Off, worked out from its
 * modules, and the switch that puts it in or out of the plan. Only here: the Account Owner
 * sees the plan read-only and turns single modules off and on inside it.
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
  const on = new Set(modules.filter((m) => m.is_on).map((m) => m.module));
  return (
    <section className="space-y-2" aria-label="Bundles">
      <h2 className="font-semibold">Bundles</h2>
      <p className="text-sm text-slate-600">{ALWAYS_ON}</p>
      <ul
        className="divide-y divide-slate-200 rounded-xl bg-white text-sm ring-1 ring-slate-200"
        data-testid="bundles"
      >
        {BUNDLES.map((b) => {
          const inPlan = modules.some((m) => m.bundle === b.code && m.in_plan);
          const state = bundleState(b, on);
          const off = b.modules.filter((m) => !on.has(m)).map(nameOf);
          return (
            <li
              key={b.code}
              className="flex items-start justify-between gap-3 p-3"
              data-bundle={b.code}
            >
              <span className="min-w-0">
                <span className="block font-medium">{b.name}</span>
                <span className="block" data-testid="bundle-state">
                  {BUNDLE_STATE_WORDS[state]}
                  {inPlan && state !== 'on' && ` · the customer turned ${list(off)} off`}
                </span>
                <span className="block text-xs text-slate-500">
                  {b.modules.map(nameOf).join(', ')}. {b.includes}
                </span>
              </span>
              <BundleSwitch
                tenantId={tenantId}
                customer={customer}
                code={b.code}
                name={b.name}
                inPlan={inPlan}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;

/** In or out of the plan; taking one out asks first, since it stops it for everyone there. */
function BundleSwitch({
  tenantId,
  customer,
  code,
  name,
  inPlan,
}: {
  tenantId: string;
  customer: string;
  code: string;
  name: string;
  inPlan: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (next: boolean) =>
    start(async () => {
      const r = await setBundle(tenantId, code, next);
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
      <div role="group" aria-label={`Turn off ${name}`} className="flex shrink-0 flex-col gap-2">
        <p className="max-w-40 text-xs text-slate-600">
          Its parts stop for everyone at {customer}. Nothing is deleted.
        </p>
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
        aria-checked={inPlan}
        aria-label={name}
        disabled={!hydrated || pending}
        onClick={() => (inPlan ? setConfirm(true) : save(true))}
        className={`${button} ${inPlan ? 'bg-emerald-700 text-white' : 'ring-1 ring-slate-300'}`}
      >
        {inPlan ? 'On' : 'Off'}
      </button>
      <ErrorBox message={error} />
    </div>
  );
}
