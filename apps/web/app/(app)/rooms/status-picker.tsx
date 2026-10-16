'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Icon } from '@/components/icon';
import { ErrorBox } from '@/components/messages';
import {
  byFloor,
  floorName,
  ROOM_STATUSES,
  ROOM_TONE,
  roomDetail,
  type RoomDetails,
  roomStatus,
  TIMED,
} from '@/lib/rooms-view';
import { useHydrated } from '@/lib/use-hydrated';
import { roomMaintenanceOpen, setRoomStatus, type RoomStatusDetails } from './actions';
import { DateInput, TimeInput } from '@/components/date-time-inputs';

/**
 * A room's new status as big buttons, each its colour, picture and word (ADR 088, 104): never a
 * code. The current one is marked. Arriving and departing ask for the time, out of order for why,
 * the day it is back and its maintenance request (ADR 117), before they are saved.
 */
export function RoomStatusButtons({
  room,
  number,
  status,
  details,
  onDone,
}: {
  room: string;
  number: string;
  status: string;
  details?: RoomDetails;
  onDone?: () => void;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const current = roomStatus(status).code;
  const [asking, setAsking] = useState<string | null>(null);
  const save = (code: string, d: RoomStatusDetails = {}) =>
    start(async () => {
      setError(null);
      const r = await setRoomStatus(room, code, d);
      if (!r.ok) return setError(r.message);
      setAsking(null);
      onDone?.();
      router.refresh();
    });
  if (asking) {
    return (
      <StatusDetailsForm
        room={room}
        number={number}
        code={asking}
        details={asking === current ? details : undefined}
        pending={pending || !hydrated}
        error={error}
        onBack={() => {
          setError(null);
          setAsking(null);
        }}
        onSave={(d) => save(asking, d)}
      />
    );
  }
  return (
    <div className="space-y-2">
      <div
        role="group"
        aria-label={`Room ${number} status`}
        className="grid grid-cols-2 gap-2"
        data-testid="room-status-buttons"
      >
        {ROOM_STATUSES.map((s) => (
          <button
            key={s.code}
            type="button"
            aria-pressed={s.code === current}
            disabled={!hydrated || pending}
            onClick={() => {
              if (TIMED.includes(s.code) || s.code === 'OOO') return setAsking(s.code);
              if (s.code === current) return onDone?.();
              save(s.code);
            }}
            className={`flex min-h-14 items-center gap-2 rounded-xl px-3 text-left text-base font-semibold ring-1 ${ROOM_TONE[s.tone]} ${
              s.code === current ? 'ring-4' : ''
            }`}
          >
            <Icon name={s.icon} className="size-6 shrink-0" />
            {s.word}
          </button>
        ))}
      </div>
      <ErrorBox message={error} />
    </div>
  );
}

/** Arriving or departing at; out of order why, till when and its maintenance request. */
function StatusDetailsForm({
  room,
  number,
  code,
  details,
  pending,
  error,
  onBack,
  onSave,
}: {
  room: string;
  number: string;
  code: string;
  details: RoomDetails | undefined;
  pending: boolean;
  error: string | null;
  onBack: () => void;
  onSave: (d: RoomStatusDetails) => void;
}) {
  const s = roomStatus(code);
  const [time, setTime] = useState(details?.at_time ?? '');
  const [reason, setReason] = useState(details?.reason ?? '');
  const [until, setUntil] = useState(details?.until ?? '');
  // the maintenance request: none, an open one, or raise one now
  const [req, setReq] = useState<string>(details?.maintenance_id ?? '');
  const [open, setOpen] = useState<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    if (code !== 'OOO') return;
    let live = true;
    void roomMaintenanceOpen(room).then((r) => {
      if (live) setOpen(r.ok ? r.data : []);
    });
    return () => {
      live = false;
    };
  }, [code, room]);
  const choices = [
    ...(details?.maintenance_id && !open?.some((o) => o.id === details.maintenance_id)
      ? [{ id: details.maintenance_id, title: details.maintenance_title ?? 'Its request' }]
      : []),
    ...(open ?? []),
  ];
  const today = new Date().toISOString().slice(0, 10);
  return (
    <form
      className="space-y-3"
      data-testid="room-status-details"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(
          code === 'OOO'
            ? {
                reason: reason.trim(),
                ...(until ? { until } : {}),
                ...(req === 'raise' ? { raise: true } : req ? { maintenance: req } : {}),
              }
            : time
              ? { time }
              : {},
        );
      }}
    >
      <p
        className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-base font-semibold ring-1 ${ROOM_TONE[s.tone]}`}
      >
        <Icon name={s.icon} className="size-6" />
        Room {number}: {s.word}
      </p>
      {code === 'OOO' ? (
        <>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Why</span>
            <input
              name="reason"
              required
              maxLength={200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="AC not cooling"
              className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Back on</span>
            <DateInput
              name="until"
              min={today}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Maintenance</span>
            <select
              name="maintenance"
              value={req}
              onChange={(e) => setReq(e.target.value)}
              className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
            >
              <option value="">No request</option>
              <option value="raise">Report it to maintenance now</option>
              {choices.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <label className="block space-y-1">
          <span className="text-sm font-medium">
            {code === 'ARR' ? 'Arriving at' : 'Departing at'}
          </span>
          <TimeInput
            name="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base"
          />
        </label>
      )}
      <ErrorBox message={error} />
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onBack}
          className="min-h-12 rounded-xl font-semibold ring-1 ring-slate-300"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={pending}
          className="min-h-12 rounded-xl bg-brand-700 font-semibold text-white disabled:opacity-60"
        >
          Save
        </button>
      </div>
    </form>
  );
}

export interface RoomTileRow {
  room_id: string;
  number: string;
  floor: string | null;
  status: string;
  can_set: boolean;
  /** whose the room is today, when given to someone else (ADR 111) */
  who?: string | null;
  /** the status's details (ADR 117) */
  details?: RoomDetails;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

/** One room's tile: its number, its status's colour and picture, and whose it is today. */
function RoomTile({ r, onTap }: { r: RoomTileRow; onTap?: (() => void) | undefined }) {
  const s = roomStatus(r.status);
  const detail = roomDetail({ status: s.code, ...r.details });
  const inner = (
    <>
      <Icon name={s.icon} className="size-5" />
      <span className="text-lg leading-tight font-bold tabular-nums">{r.number}</span>
      {detail && (
        <span className="text-[11px] leading-none font-semibold" data-testid="room-detail">
          {detail}
        </span>
      )}
      {r.who && (
        <span className="text-[11px] leading-none font-semibold opacity-80" data-testid="room-who">
          {initials(r.who)}
        </span>
      )}
    </>
  );
  const common = {
    'aria-label': `Room ${r.number}: ${s.word}${detail ? ` ${detail}` : ''}${r.who ? `, ${r.who}'s` : ''}`,
    'data-testid': 'room',
    'data-room': r.number,
    'data-status': s.code,
    className: `flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-xl ring-1 ${ROOM_TONE[s.tone]}`,
  };
  return onTap ? (
    <button type="button" onClick={onTap} {...common}>
      {inner}
    </button>
  ) : (
    <div role="img" {...common}>
      {inner}
    </div>
  );
}

/**
 * Every room as a tile, floor by floor (ADR 104). Whoever may change a room's status taps it
 * and chooses the new one from big buttons.
 */
export function RoomGrid({ rooms }: { rooms: RoomTileRow[] }) {
  const [open, setOpen] = useState<RoomTileRow | null>(null);
  const floors = byFloor(rooms);
  return (
    <>
      {floors.map((f) => (
        <section key={f.floor} className="space-y-2" aria-label={floorName(f.floor)}>
          {floors.length > 1 && (
            <h2 className="text-sm font-semibold text-slate-500">{floorName(f.floor)}</h2>
          )}
          <div className="grid grid-cols-4 gap-2">
            {f.rooms.map((r) => (
              <RoomTile key={r.room_id} r={r} onTap={r.can_set ? () => setOpen(r) : undefined} />
            ))}
          </div>
        </section>
      ))}
      {open && (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/50"
          onClick={() => setOpen(null)}
        >
          <section
            role="dialog"
            aria-label={`Room ${open.number}`}
            data-testid="room-sheet"
            className="w-full space-y-3 rounded-t-2xl bg-white p-4 pb-8 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">Room {open.number}</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(null)}
                className="flex size-11 items-center justify-center rounded-full ring-1 ring-slate-300"
              >
                <Icon name="x" className="size-5" />
              </button>
            </div>
            {open.details?.reason && (
              <p className="text-sm text-slate-700" data-testid="room-why">
                {open.details.reason}
                {open.details.maintenance_title && ` · ${open.details.maintenance_title}`}
              </p>
            )}
            <RoomStatusButtons
              room={open.room_id}
              number={open.number}
              status={open.status}
              {...(open.details ? { details: open.details } : {})}
              onDone={() => setOpen(null)}
            />
          </section>
        </div>
      )}
    </>
  );
}

/**
 * The statuses there are, each with its colour, picture and how many rooms have it. With
 * `filter`, each is a link that shows only those rooms, and the current one links back to all
 * (ADR 117).
 */
export function RoomLegend({
  rooms,
  filter,
}: {
  rooms: { status: string }[];
  /** the chips as links (a server page passes strings, never a function): `base` + `&status=` */
  filter?: { current: string | null; base: string };
}) {
  const counts = ROOM_STATUSES.map((s) => ({
    ...s,
    n: rooms.filter((r) => roomStatus(r.status).code === s.code).length,
  })).filter((s) => s.n > 0);
  return (
    <ul className="flex flex-wrap gap-2" data-testid="room-counts" aria-label="Room status">
      {counts.map((s) => {
        const chip = `inline-flex min-h-8 items-center gap-1 rounded-full px-2.5 text-sm font-medium ring-1 ${ROOM_TONE[s.tone]}`;
        const body = (
          <>
            <Icon name={s.icon} className="size-4" />
            <span className="tabular-nums">{s.n}</span> {s.word.toLowerCase()}
          </>
        );
        if (!filter) {
          return (
            <li key={s.code} className={chip}>
              {body}
            </li>
          );
        }
        const on = filter.current === s.code;
        return (
          <li key={s.code}>
            <Link
              href={on ? filter.base : `${filter.base}&status=${s.code}`}
              aria-current={on ? 'true' : undefined}
              data-testid="room-filter"
              data-status={s.code}
              className={`${chip} min-h-11 ${on ? 'ring-4' : ''}`}
            >
              {body}
            </Link>
          </li>
        );
      })}
      {filter?.current && (
        <li>
          <Link
            href={filter.base}
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium underline"
          >
            All rooms
          </Link>
        </li>
      )}
    </ul>
  );
}
