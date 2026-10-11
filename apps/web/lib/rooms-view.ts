import type { IconName } from '@/components/icon';

// Room status (ADR 088, 117): the codes hotels use, with their words; no house use (ADR 117). The database keeps the
// same list (ops.room_status_name). People never see a code (ADR 104): each status is a word,
// a colour and a picture on the room's tile.

export type RoomTone = 'clean' | 'dirty' | 'guest' | 'arriving' | 'leaving' | 'closed';

export const ROOM_STATUSES = [
  { code: 'VC', name: 'Vacant clean', word: 'Clean', icon: 'check', tone: 'clean' },
  { code: 'VD', name: 'Vacant dirty', word: 'Dirty', icon: 'broom', tone: 'dirty' },
  { code: 'OCC', name: 'Occupied', word: 'Guest in', icon: 'user', tone: 'guest' },
  { code: 'ARR', name: 'Arriving', word: 'Arriving', icon: 'bell', tone: 'arriving' },
  { code: 'DEP', name: 'Leaving', word: 'Leaving', icon: 'out', tone: 'leaving' },
  { code: 'OOO', name: 'Out of order', word: 'Out of order', icon: 'wrench', tone: 'closed' },
] as const satisfies readonly {
  code: string;
  name: string;
  word: string;
  icon: IconName;
  tone: RoomTone;
}[];

export type RoomStatus = (typeof ROOM_STATUSES)[number]['code'];
export type RoomStatusInfo = (typeof ROOM_STATUSES)[number];

/** A room with no status yet is clean (the database's default). */
export function roomStatus(code: string | null | undefined): RoomStatusInfo {
  return ROOM_STATUSES.find((s) => s.code === code) ?? ROOM_STATUSES[0];
}

export function roomStatusName(code: string | null | undefined): string {
  return roomStatus(code).name;
}

/** The tile's colours per status, from the palette (both themes). */
export const ROOM_TONE: Record<RoomTone, string> = {
  clean: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  dirty: 'bg-amber-50 text-amber-800 ring-amber-300',
  guest: 'bg-sky-50 text-sky-800 ring-sky-300',
  arriving: 'bg-violet-50 text-violet-800 ring-violet-300',
  leaving: 'bg-brand-50 text-brand-800 ring-brand-200',
  closed: 'bg-rose-50 text-rose-800 ring-rose-300',
};

/** A status's details set on a room (ADR 117). */
export interface RoomDetails {
  at_time?: string | null;
  reason?: string | null;
  until?: string | null;
  maintenance_id?: string | null;
  maintenance_title?: string | null;
}

/** A status that carries a time (ADR 117): arriving and leaving rooms. */
export const TIMED: readonly string[] = ['ARR', 'DEP'];

/** The line under a room's number on its tile: "14:00", "till 20 Oct" (ADR 117). */
export function roomDetail(r: { status: string; at_time?: string | null; until?: string | null }) {
  if (TIMED.includes(r.status) && r.at_time) return r.at_time;
  if (r.status === 'OOO' && r.until) {
    const d = new Date(`${r.until}T00:00:00Z`);
    return `till ${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
  }
  return null;
}

/** Rooms by floor, in the order given; one group with no name when no room has a floor. */
export function byFloor<T extends { floor: string | null }>(
  rooms: readonly T[],
): { floor: string; rooms: T[] }[] {
  const out: { floor: string; rooms: T[] }[] = [];
  for (const r of rooms) {
    const f = r.floor ?? '';
    const g = out.find((x) => x.floor === f);
    if (g) g.rooms.push(r);
    else out.push({ floor: f, rooms: [r] });
  }
  return out;
}

/** "Floor 2", or the floor's own name when it is a word ("Pool level"). */
export function floorName(floor: string): string {
  if (!floor) return 'Rooms';
  return /^\d+$/.test(floor) ? `Floor ${floor}` : floor;
}
