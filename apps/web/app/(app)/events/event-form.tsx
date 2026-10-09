'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { ErrorBox, inputClass, primaryButton, secondaryButton } from '@/components/messages';
import { addDays, localToInstant } from '@/lib/dates';
import { saveEvent, type EventRequirementInput } from '../roster/actions';
import type { EventFormOptions } from './options';
import { ItemThumb } from '@/components/item-thumb';

export interface EventDraft {
  id: string;
  name: string;
  date: string;
  start: string;
  end: string;
  covers: number;
  notes: string;
  status: 'planned' | 'confirmed';
  items: { item_id: string; qty: string }[];
  roles: { role_code: string; headcount: string; start: string; end: string }[];
}

/** Create or edit an event: time window in the location's timezone, covers, requirements. */
export function EventForm({
  node,
  tz,
  today,
  options,
  initial,
}: {
  node: string;
  tz: string;
  today: string;
  options: EventFormOptions;
  initial?: EventDraft;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const [e, setE] = useState<EventDraft>(
    initial ?? {
      id: '',
      name: '',
      date: addDays(today, 7),
      start: '12:00',
      end: '15:00',
      covers: 50,
      notes: '',
      status: 'planned',
      items: [],
      roles: [],
    },
  );
  const set = (patch: Partial<EventDraft>) => setE((x) => ({ ...x, ...patch }));
  // times after midnight (end before start) fall on the next day
  const instant = (time: string, after?: string) =>
    localToInstant(after !== undefined && time <= after ? addDays(e.date, 1) : e.date, time, tz);

  const submit = () =>
    start(async () => {
      setError(null);
      const requirements: EventRequirementInput[] = [
        ...e.items
          .filter((i) => i.item_id && Number(i.qty) > 0)
          .map((i) => ({ kind: 'item' as const, item_id: i.item_id, qty: Number(i.qty) })),
        ...e.roles
          .filter((r) => r.role_code && Number(r.headcount) > 0)
          .map((r) => ({
            kind: 'role' as const,
            role_code: r.role_code,
            headcount: Number(r.headcount),
            starts_at: instant(r.start),
            ends_at: instant(r.end, r.start),
          })),
      ];
      const r = await saveEvent({
        id: e.id || null,
        node,
        name: e.name,
        startsAt: instant(e.start),
        endsAt: instant(e.end, e.start),
        covers: e.covers,
        notes: e.notes,
        status: e.status,
        requirements,
        idempotencyKey: key.current,
      });
      if (!r.ok) return setError(r.message);
      router.push(`/events/${r.data}?node=${node}`);
      router.refresh();
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
      aria-label="Event"
    >
      <label className="block text-sm">
        Name
        <input
          value={e.name}
          onChange={(x) => set({ name: x.target.value })}
          required
          maxLength={200}
          className={inputClass}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 block text-sm">
          Date
          <input
            type="date"
            value={e.date}
            min={today}
            onChange={(x) => set({ date: x.target.value })}
            required
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          Start
          <input
            type="time"
            value={e.start}
            onChange={(x) => set({ start: x.target.value })}
            required
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          End
          <input
            type="time"
            value={e.end}
            onChange={(x) => set({ end: x.target.value })}
            required
            className={inputClass}
          />
        </label>
        <label className="col-span-2 block text-sm">
          Covers
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={e.covers}
            onChange={(x) => set({ covers: Number(x.target.value) })}
            required
            className={inputClass}
          />
        </label>
      </div>
      <label className="block text-sm">
        Status
        <select
          value={e.status}
          onChange={(x) => set({ status: x.target.value as EventDraft['status'] })}
          className={inputClass}
        >
          <option value="planned">Planned</option>
          <option value="confirmed">Confirmed</option>
        </select>
      </label>
      <label className="block text-sm">
        Notes
        <input
          value={e.notes}
          onChange={(x) => set({ notes: x.target.value })}
          maxLength={2000}
          className={inputClass}
        />
      </label>

      <fieldset className="space-y-2" aria-label="Staff needed">
        <legend className="text-sm font-semibold">Staff needed</legend>
        {e.roles.map((r, i) => (
          <div
            key={i}
            className="grid grid-cols-4 gap-2 rounded-xl bg-white p-2 ring-1 ring-slate-200"
          >
            <select
              aria-label="Role"
              value={r.role_code}
              onChange={(x) =>
                set({
                  roles: e.roles.map((y, j) => (j === i ? { ...y, role_code: x.target.value } : y)),
                })
              }
              className={`${inputClass} col-span-3`}
            >
              {options.roles.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </select>
            <input
              aria-label="Headcount"
              type="number"
              inputMode="numeric"
              min={1}
              value={r.headcount}
              onChange={(x) =>
                set({
                  roles: e.roles.map((y, j) => (j === i ? { ...y, headcount: x.target.value } : y)),
                })
              }
              className={inputClass}
            />
            <input
              aria-label="From"
              type="time"
              value={r.start}
              onChange={(x) =>
                set({
                  roles: e.roles.map((y, j) => (j === i ? { ...y, start: x.target.value } : y)),
                })
              }
              className={`${inputClass} col-span-2`}
            />
            <input
              aria-label="Until"
              type="time"
              value={r.end}
              onChange={(x) =>
                set({ roles: e.roles.map((y, j) => (j === i ? { ...y, end: x.target.value } : y)) })
              }
              className={`${inputClass} col-span-2`}
            />
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            set({
              roles: [
                ...e.roles,
                {
                  role_code: options.roles[0]?.code ?? '',
                  headcount: '2',
                  start: e.start,
                  end: e.end,
                },
              ],
            })
          }
          className={secondaryButton}
          disabled={options.roles.length === 0}
        >
          Add staff
        </button>
      </fieldset>

      <fieldset className="space-y-2" aria-label="Items needed">
        <legend className="text-sm font-semibold">Items needed</legend>
        {options.items.length === 0 ? (
          <p className="text-xs text-slate-500">
            You can&apos;t see the item list, so only staff can be added.
          </p>
        ) : (
          <>
            {e.items.map((it, i) => (
              <div key={i} className="flex items-center gap-2">
                <ItemThumb
                  name={options.items.find((o) => o.id === it.item_id)?.name}
                  size="size-10"
                />
                <select
                  aria-label="Item"
                  value={it.item_id}
                  onChange={(x) =>
                    set({
                      items: e.items.map((y, j) =>
                        j === i ? { ...y, item_id: x.target.value } : y,
                      ),
                    })
                  }
                  className={`${inputClass} min-w-0 flex-1`}
                >
                  {options.items.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.base_uom})
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Quantity"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={it.qty}
                  onChange={(x) =>
                    set({
                      items: e.items.map((y, j) => (j === i ? { ...y, qty: x.target.value } : y)),
                    })
                  }
                  className={`${inputClass} max-w-24 text-right`}
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                set({ items: [...e.items, { item_id: options.items[0]!.id, qty: '1' }] })
              }
              className={secondaryButton}
            >
              Add item
            </button>
          </>
        )}
      </fieldset>

      <button type="submit" disabled={pending} className={primaryButton}>
        {e.id ? 'Save changes' : 'Create event'}
      </button>
      <ErrorBox message={error} />
    </form>
  );
}
