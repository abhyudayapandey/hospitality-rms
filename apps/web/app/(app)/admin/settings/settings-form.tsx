'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ErrorBox } from '@/components/messages';
import { TARGETS, type CompanySettings, type TargetKey } from '@/lib/settings';
import { saveCompanySettings } from '../actions';

const field =
  'min-h-12 w-24 rounded-lg border border-slate-300 bg-white px-3 text-right tabular-nums disabled:bg-slate-50';

/** The company's targets and settings; saved together, checked by the database. */
export function SettingsForm({
  settings,
  canEdit,
}: {
  settings: CompanySettings;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [targets, setTargets] = useState<Record<TargetKey, string>>(
    Object.fromEntries(TARGETS.map((t) => [t.key, String(settings.targets[t.key])])) as Record<
      TargetKey,
      string
    >,
  );
  const [popular, setPopular] = useState(String(settings.menu_popular_pct));
  const [overtime, setOvertime] = useState(String(settings.overtime_multiplier));
  const [prices, setPrices] = useState(settings.po_send_prices);
  const [swaps, setSwaps] = useState(settings.swaps_managers_only);
  const [countDays, setCountDays] = useState(String(settings.count_due_days));
  const [usual, setUsual] = useState(String(settings.usual_qty_factor));

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveCompanySettings({
        targets: Object.fromEntries(TARGETS.map((t) => [t.key, Number(targets[t.key])])),
        menu_popular_pct: Number(popular),
        overtime_multiplier: Number(overtime),
        po_send_prices: prices,
        swaps_managers_only: swaps,
        count_due_days: Number(countDays),
        usual_qty_factor: Number(usual),
      });
      if (!r.ok) {
        setError(r.message);
        setSaved(false);
      } else {
        setError(null);
        setSaved(true);
        router.refresh();
      }
    });
  };

  return (
    <form onSubmit={save} className="space-y-6" data-testid="settings">
      <fieldset className="space-y-2" disabled={!canEdit}>
        <legend className="text-sm font-semibold text-slate-700">Targets</legend>
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          {TARGETS.map((t) => (
            <li key={t.key} className="flex items-center justify-between gap-3 p-3">
              <label htmlFor={`target-${t.key}`} className="min-w-0">
                <span className="block font-medium">{t.label}</span>
                <span className="block text-xs text-slate-500">
                  {t.key === 'labour'
                    ? 'at most'
                    : t.better === 'down'
                      ? 'of sales, at most'
                      : 'at least'}
                </span>
              </label>
              <span className="flex items-center gap-1">
                <input
                  id={`target-${t.key}`}
                  name={`target-${t.key}`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step="0.5"
                  required
                  className={field}
                  value={targets[t.key]}
                  onChange={(e) => setTargets({ ...targets, [t.key]: e.target.value })}
                />
                <span className="text-sm text-slate-600">%</span>
              </span>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset className="space-y-2" disabled={!canEdit}>
        <legend className="text-sm font-semibold text-slate-700">Reports</legend>
        <ul className="divide-y divide-slate-100 rounded-xl bg-white ring-1 ring-slate-200">
          <li className="flex items-center justify-between gap-3 p-3">
            <label htmlFor="menu-popular" className="min-w-0">
              <span className="block font-medium">Popular dish</span>
              <span className="block text-xs text-slate-500">
                Menu engineering: a dish is popular from this share of an equal split (70% is usual)
              </span>
            </label>
            <span className="flex items-center gap-1">
              <input
                id="menu-popular"
                type="number"
                inputMode="numeric"
                min={10}
                max={100}
                step="5"
                required
                className={field}
                value={popular}
                onChange={(e) => setPopular(e.target.value)}
              />
              <span className="text-sm text-slate-600">%</span>
            </span>
          </li>
          <li className="flex items-center justify-between gap-3 p-3">
            <label htmlFor="overtime" className="min-w-0">
              <span className="block font-medium">Overtime pay</span>
              <span className="block text-xs text-slate-500">
                Hourly staff, for hours over the weekly limit. Earlier days follow overnight.
              </span>
            </label>
            <span className="flex items-center gap-1">
              <input
                id="overtime"
                type="number"
                inputMode="decimal"
                min={1}
                max={3}
                step="0.25"
                required
                className={field}
                value={overtime}
                onChange={(e) => setOvertime(e.target.value)}
              />
              <span className="text-sm text-slate-600">×</span>
            </span>
          </li>
        </ul>
      </fieldset>

      <fieldset className="space-y-2" disabled={!canEdit}>
        <legend className="text-sm font-semibold text-slate-700">Orders</legend>
        <label className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <span className="min-w-0">
            <span className="block font-medium">Show prices on orders sent to suppliers</span>
            <span className="block text-xs text-slate-500">
              Off: the supplier sees items and quantities only.
            </span>
          </span>
          <input
            id="po-prices"
            type="checkbox"
            className="h-6 w-6 shrink-0"
            checked={prices}
            onChange={(e) => setPrices(e.target.checked)}
          />
        </label>
        <div className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <label htmlFor="usual-qty" className="min-w-0">
            <span className="block font-medium">A usual quantity is up to</span>
            <span className="block text-xs text-slate-500">
              times what the store uses in a week (the last 4 weeks). Orders and requests for menu
              items up to this need no approval; anything more, or off the menu, goes to the
              department head.
            </span>
          </label>
          <span className="flex items-center gap-1">
            <input
              id="usual-qty"
              type="number"
              inputMode="decimal"
              min={1}
              max={10}
              step="0.25"
              required
              className={field}
              value={usual}
              onChange={(e) => setUsual(e.target.value)}
            />
            <span className="text-sm text-slate-600">×</span>
          </span>
        </div>
      </fieldset>

      <fieldset className="space-y-2" disabled={!canEdit}>
        <legend className="text-sm font-semibold text-slate-700">People and stock</legend>
        <label className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <span className="min-w-0">
            <span className="block font-medium">Only managers swap shifts</span>
            <span className="block text-xs text-slate-500">
              On: only people who change the roster offer a swap. Off: staff swap with each other,
              and a manager approves.
            </span>
          </span>
          <input
            id="swaps-managers-only"
            type="checkbox"
            className="h-6 w-6 shrink-0"
            checked={swaps}
            onChange={(e) => setSwaps(e.target.checked)}
          />
        </label>
        <div className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <label htmlFor="count-due" className="min-w-0">
            <span className="block font-medium">Count each store every</span>
            <span className="block text-xs text-slate-500">
              The Stock screen says when a count is due.
            </span>
          </label>
          <span className="flex items-center gap-1">
            <input
              id="count-due"
              type="number"
              inputMode="numeric"
              min={1}
              max={60}
              step="1"
              required
              className={field}
              value={countDays}
              onChange={(e) => setCountDays(e.target.value)}
            />
            <span className="text-sm text-slate-600">days</span>
          </span>
        </div>
      </fieldset>

      {canEdit && (
        <div className="space-y-2">
          <button
            disabled={pending}
            className="min-h-12 w-full rounded-lg bg-brand-700 font-medium text-white disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
          {saved && !error && (
            <p role="status" className="text-sm text-emerald-700">
              Saved.
            </p>
          )}
          <ErrorBox message={error} />
        </div>
      )}
    </form>
  );
}
