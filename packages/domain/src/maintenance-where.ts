// Where a problem is (ADR 125): a place a person can point at, never a department. A room is
// then picked by its number. A place that is a department's (the kitchen, the bar) is offered
// only where the outlet has that department; the pool only at a hotel.

export interface MaintenanceWhere {
  code: string;
  word: string;
  /** offered only where the outlet has a department with this catalogue code */
  department?: string;
  /** offered only where the outlet has rooms, or is a hotel */
  needs?: 'rooms' | 'hotel';
}

export const MAINTENANCE_WHERE: readonly MaintenanceWhere[] = [
  { code: 'room', word: 'A room', needs: 'rooms' },
  { code: 'common_areas', word: 'Lobby & corridors' },
  { code: 'restaurant', word: 'Restaurant', department: 'RESTAURANT' },
  { code: 'bar', word: 'Bar', department: 'BAR' },
  { code: 'kitchen', word: 'Kitchen', department: 'KITCHEN' },
  { code: 'banquet_hall', word: 'Banquet hall', department: 'BANQUETS' },
  { code: 'pool', word: 'Pool', needs: 'hotel' },
  { code: 'terrace', word: 'Terrace' },
  { code: 'garden', word: 'Garden' },
  { code: 'parking', word: 'Parking' },
  { code: 'store', word: 'Store' },
  { code: 'laundry', word: 'Laundry', department: 'HOUSEKEEPING' },
  { code: 'staff_area', word: 'Staff area' },
  { code: 'outside', word: 'Outside' },
];

export const MAINTENANCE_WHERE_CODES: readonly string[] = MAINTENANCE_WHERE.map((w) => w.code);

export function maintenanceWhereWord(code: string | null | undefined): string | null {
  return MAINTENANCE_WHERE.find((w) => w.code === code)?.word ?? null;
}
