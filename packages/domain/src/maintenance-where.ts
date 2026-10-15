// Where a problem is (ADR 125): a place a person can point at, never a department. A room is
// then picked by its number. A place that is a department's (the kitchen, the bar) is offered
// only where the outlet has that department; the pool and parking only at a hotel; a terrace or
// garden at a hotel, or where one of the outlet's floor sections is called that (ADR 160).

export interface MaintenanceWhere {
  code: string;
  word: string;
  /** offered only where the outlet has a department with this catalogue code */
  department?: string;
  /** offered only where the outlet has rooms, or is a hotel; `outdoor`: a hotel, or an outlet
   * with a floor section of that name (a bar's "Terrace", ADR 160) */
  needs?: 'rooms' | 'hotel' | 'outdoor';
}

export const MAINTENANCE_WHERE: readonly MaintenanceWhere[] = [
  { code: 'room', word: 'A room', needs: 'rooms' },
  { code: 'common_areas', word: 'Lobby & corridors' },
  { code: 'restaurant', word: 'Restaurant', department: 'RESTAURANT' },
  { code: 'bar', word: 'Bar', department: 'BAR' },
  { code: 'kitchen', word: 'Kitchen', department: 'KITCHEN' },
  { code: 'banquet_hall', word: 'Banquet hall', department: 'BANQUETS' },
  { code: 'pool', word: 'Pool', needs: 'hotel' },
  { code: 'terrace', word: 'Terrace', needs: 'outdoor' },
  { code: 'garden', word: 'Garden', needs: 'outdoor' },
  { code: 'parking', word: 'Parking', needs: 'hotel' },
  { code: 'store', word: 'Store' },
  { code: 'laundry', word: 'Laundry', department: 'HOUSEKEEPING' },
  { code: 'staff_area', word: 'Staff area' },
  { code: 'outside', word: 'Outside' },
];

export const MAINTENANCE_WHERE_CODES: readonly string[] = MAINTENANCE_WHERE.map((w) => w.code);

export function maintenanceWhereWord(code: string | null | undefined): string | null {
  return MAINTENANCE_WHERE.find((w) => w.code === code)?.word ?? null;
}

/** Departments whose place is not one of their own: the front office works in the lobby. */
const DEPARTMENT_WHERE: Readonly<Record<string, string>> = {
  FRONT_OFFICE: 'common_areas',
  SECURITY: 'common_areas',
  ENGINEERING: 'staff_area',
  STORES: 'store',
  PURCHASE: 'store',
};

/**
 * Where a person who works at this place most likely points (ADR 125): its department's own
 * location (a kitchen's people, the kitchen). A place code ends in its department's catalogue
 * code (TEST-HOTEL-1.0-KITCHEN, PASSPORT-ASSAGAO-FRONT-OFFICE).
 */
export function whereForPlace(placeCode: string | null | undefined): string | null {
  if (!placeCode) return null;
  const codes = [...MAINTENANCE_WHERE.map((w) => w.department), ...Object.keys(DEPARTMENT_WHERE)]
    .filter((d): d is string => Boolean(d))
    .sort((a, b) => b.length - a.length);
  const dept = codes.find((d) => placeCode.toUpperCase().endsWith(`-${d.replaceAll('_', '-')}`));
  if (!dept) return null;
  return DEPARTMENT_WHERE[dept] ?? MAINTENANCE_WHERE.find((w) => w.department === dept)!.code;
}
