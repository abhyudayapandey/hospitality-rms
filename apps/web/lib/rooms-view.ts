import type { IconName } from '@/components/icon';

// Room status (ADR 088): the codes hotels use, with their words. The database keeps the
// same list (ops.room_status_name). People never see a code (ADR 104): each status is a word,
// a colour and a picture on the room's tile.

export type RoomTone = 'clean' | 'dirty' | 'guest' | 'arriving' | 'leaving' | 'closed' | 'house';

export const ROOM_STATUSES = [
  { code: 'VC', name: 'Vacant clean', word: 'Clean', icon: 'check', tone: 'clean' },
  { code: 'VD', name: 'Vacant dirty', word: 'Dirty', icon: 'broom', tone: 'dirty' },
  { code: 'OCC', name: 'Occupied', word: 'Guest in', icon: 'user', tone: 'guest' },
  { code: 'ARR', name: 'Arriving', word: 'Arriving', icon: 'bell', tone: 'arriving' },
  { code: 'DEP', name: 'Departing', word: 'Leaving', icon: 'out', tone: 'leaving' },
  { code: 'OOO', name: 'Out of order', word: 'Out of order', icon: 'wrench', tone: 'closed' },
  { code: 'HM', name: 'House use', word: 'House use', icon: 'lock', tone: 'house' },
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
  house: 'bg-slate-100 text-slate-700 ring-slate-300',
};

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
