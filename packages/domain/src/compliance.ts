// The compliance library (ADR 069), taken from the SOP manuals' licence lists and compliance
// calendars (docs/sop/). An outlet with Compliance in its customer's plan starts with the
// licences its format needs (to fill in: number, authority, expiry) and the calendar jobs its
// format runs, each owned by a kind of role resolved at the outlet (its kitchen head, its
// chief engineer, else its manager). Product code, like the checklist library: a copy keeps
// its library code and version.

import type { OutletFormat } from './formats';
import type { ExtraCode } from './templates';

export interface LicenceKind {
  code: string;
  name: string;
  /** Who issues it, as the SOP names them. */
  authority: string;
  /** The formats that need it; with `extras`, any outlet with one of those extras too. */
  formats: readonly OutletFormat[];
  extras?: readonly ExtraCode[];
  from: string;
}

/** Who a calendar job goes to at an outlet: its kitchen head, chief engineer or manager. */
export type CalendarOwner = 'kitchen' | 'engineering' | 'manager';

export interface CalendarJob {
  code: string;
  version: number;
  name: string;
  /** 1, 2, 3, 4, 6, 12, 24 or 36 months. */
  everyMonths: number;
  owner: CalendarOwner;
  /** A report or certificate is kept with each time it is done. */
  needsProof: boolean;
  formats: readonly OutletFormat[];
  extras?: readonly ExtraCode[];
  /** A fixed yearly date (MM-DD), as the FSSAI annual return's 31 May. */
  dueOn?: string;
  from: string;
}

const ALL: readonly OutletFormat[] = ['restaurant', 'bar_pub', 'qsr', 'cloud_kitchen', 'hotel'];
const DINE: readonly OutletFormat[] = ['restaurant', 'bar_pub', 'qsr', 'hotel'];

export const LICENCE_KINDS: readonly LicenceKind[] = [
  {
    code: 'FSSAI',
    name: 'FSSAI licence',
    authority: 'FSSAI',
    formats: ALL,
    from: 'All SOPs: licences (registration, state or central licence, 1–5 years)',
  },
  {
    code: 'FIRE_NOC',
    name: 'Fire NOC',
    authority: 'State fire services',
    formats: ALL,
    from: 'All SOPs: fire safety',
  },
  {
    code: 'TRADE_HEALTH',
    name: 'Trade / health licence',
    authority: 'Municipal corporation',
    formats: ALL,
    from: 'R licences (renewed yearly); H other licences; C, Q licence renewals',
  },
  {
    code: 'SHOPS_ESTABLISHMENTS',
    name: 'Shops & Establishments registration',
    authority: 'State labour department',
    formats: ALL,
    from: 'R, H licences',
  },
  {
    code: 'EATING_HOUSE',
    name: 'Eating house licence',
    authority: 'Police (where the city requires it)',
    formats: DINE,
    from: 'R licences; H other licences',
  },
  {
    code: 'MUSIC',
    name: 'Music licences (PPL / IPRS)',
    authority: 'PPL / IPRS',
    formats: ['restaurant', 'bar_pub', 'hotel'],
    from: 'R, B, H calendars (on expiry)',
  },
  {
    code: 'EXCISE_BAR',
    name: 'Excise bar licence',
    authority: 'State excise',
    formats: ['bar_pub'],
    extras: ['bar'],
    from: 'B licences (often renewed 1 April); H liquor; R liquor licence',
  },
  {
    code: 'POLICE_PERFORMANCE',
    name: 'Police / performance licence',
    authority: 'Police',
    formats: ['bar_pub'],
    from: 'B calendar (annually)',
  },
  {
    code: 'LIFT',
    name: 'Lift licence',
    authority: 'Electrical inspectorate',
    formats: ['hotel'],
    from: 'H other licences; H calendar (annually)',
  },
  {
    code: 'SPCB_CONSENT',
    name: 'SPCB consent to operate',
    authority: 'State pollution control board',
    formats: ['hotel'],
    from: 'H other licences',
  },
  {
    code: 'SWIMMING_POOL',
    name: 'Swimming pool licence',
    authority: 'Municipal corporation',
    formats: [],
    extras: ['pool'],
    from: 'H other licences',
  },
];

export const CALENDAR_JOBS: readonly CalendarJob[] = [
  {
    code: 'PEST-CONTROL',
    version: 1,
    name: 'Pest control service',
    everyMonths: 1,
    owner: 'manager',
    needsProof: true,
    formats: ALL,
    from: 'R FA-03 and calendar; H, B, C, Q calendars (monthly)',
  },
  {
    code: 'EXTINGUISHER-CHECK',
    version: 1,
    name: 'Fire extinguisher check',
    everyMonths: 1,
    owner: 'engineering',
    needsProof: false,
    formats: ['restaurant', 'bar_pub', 'hotel'],
    from: 'R FA-05 and calendar; H, B calendars (monthly)',
  },
  {
    code: 'DUCT-CLEANING',
    version: 1,
    name: 'Kitchen exhaust duct cleaning',
    everyMonths: 6,
    owner: 'kitchen',
    needsProof: true,
    formats: ALL,
    from: 'R FA-01 and calendar; H, C, Q calendars (every 6 months)',
  },
  {
    code: 'WATER-TEST',
    version: 1,
    name: 'Water test at a NABL lab',
    everyMonths: 6,
    owner: 'engineering',
    needsProof: true,
    formats: ALL,
    from: 'R, H, C, Q calendars (every 6 months)',
  },
  {
    code: 'TANK-CLEANING',
    version: 1,
    name: 'Water tank cleaning',
    everyMonths: 6,
    owner: 'engineering',
    needsProof: true,
    formats: ['restaurant', 'hotel'],
    from: 'R FA-01 and calendar; H EN-07 and calendar (every 6 months)',
  },
  {
    code: 'FIRE-DRILL',
    version: 1,
    name: 'Fire drill',
    everyMonths: 6,
    owner: 'manager',
    needsProof: false,
    formats: ALL,
    from: 'R FA-05; H evacuation drill; C, Q calendars (every 6 months)',
  },
  {
    code: 'FOOD-HANDLER-MEDICALS',
    version: 1,
    name: 'Food handler medicals',
    everyMonths: 12,
    owner: 'kitchen',
    needsProof: true,
    formats: ALL,
    from: 'All calendars (annually)',
  },
  {
    code: 'FSSAI-ANNUAL-RETURN',
    version: 1,
    name: 'FSSAI annual return (Form D1)',
    everyMonths: 12,
    owner: 'manager',
    needsProof: true,
    formats: ['restaurant', 'qsr', 'hotel'],
    dueOn: '05-31',
    from: 'R, H, Q calendars (by 31 May, where it applies)',
  },
  {
    code: 'LIFT-RESCUE-DRILL',
    version: 1,
    name: 'Lift rescue drill',
    everyMonths: 3,
    owner: 'engineering',
    needsProof: false,
    formats: ['hotel'],
    from: 'H calendar (quarterly)',
  },
  {
    code: 'ELECTRICAL-AUDIT',
    version: 1,
    name: 'Earthing and electrical audit',
    everyMonths: 12,
    owner: 'engineering',
    needsProof: true,
    formats: ['hotel'],
    from: 'H calendar (annually)',
  },
];

export const LICENCE_KIND_BY_CODE: ReadonlyMap<string, LicenceKind> = new Map(
  LICENCE_KINDS.map((k) => [k.code, k]),
);
export const CALENDAR_JOB_BY_CODE: ReadonlyMap<string, CalendarJob> = new Map(
  CALENDAR_JOBS.map((j) => [j.code, j]),
);

const applies = (
  x: { formats: readonly OutletFormat[]; extras?: readonly ExtraCode[] },
  format: OutletFormat,
  extras: readonly string[],
) => x.formats.includes(format) || (x.extras ?? []).some((e) => extras.includes(e));

/** The licences an outlet of this format, with these extras, needs. */
export function licencesFor(format: OutletFormat, extras: readonly string[]): LicenceKind[] {
  return LICENCE_KINDS.filter((k) => applies(k, format, extras));
}

/** The calendar jobs an outlet of this format, with these extras, runs. */
export function calendarFor(format: OutletFormat, extras: readonly string[]): CalendarJob[] {
  return CALENDAR_JOBS.filter((j) => applies(j, format, extras));
}

/** The first due date of a new copy: its fixed yearly date, else 30 days on (time to record
 * when it was really last done). `today` is YYYY-MM-DD. */
export function firstDue(job: CalendarJob, today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  if (job.dueOn) {
    const year = d.getUTCFullYear();
    const thisYear = `${year}-${job.dueOn}`;
    return thisYear >= today ? thisYear : `${year + 1}-${job.dueOn}`;
  }
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

/** Days left, in words: "Expires in 45 days", "Expired 3 days ago", "Due today". */
export function daysWords(daysLeft: number, verb: 'Expires' | 'Due'): string {
  if (daysLeft === 0) return `${verb} today`;
  if (daysLeft > 0) return `${verb} in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  const ago = -daysLeft;
  return verb === 'Expires'
    ? `Expired ${ago} day${ago === 1 ? '' : 's'} ago`
    : `Overdue ${ago} day${ago === 1 ? '' : 's'}`;
}

/** "Every month", "Every 6 months", "Every year". */
export function everyWords(months: number): string {
  if (months === 1) return 'Every month';
  if (months === 12) return 'Every year';
  if (months % 12 === 0) return `Every ${months / 12} years`;
  return `Every ${months} months`;
}
