// Room status (ADR 088): the codes hotels use, with their words. The database keeps the
// same list (ops.room_status_name).

export const ROOM_STATUSES = [
  { code: 'VC', name: 'Vacant clean' },
  { code: 'VD', name: 'Vacant dirty' },
  { code: 'OCC', name: 'Occupied' },
  { code: 'ARR', name: 'Arriving' },
  { code: 'DEP', name: 'Departing' },
  { code: 'OOO', name: 'Out of order' },
  { code: 'HM', name: 'House use' },
] as const;

export type RoomStatus = (typeof ROOM_STATUSES)[number]['code'];

export function roomStatusName(code: string | null | undefined): string {
  return ROOM_STATUSES.find((s) => s.code === code)?.name ?? 'Vacant clean';
}
