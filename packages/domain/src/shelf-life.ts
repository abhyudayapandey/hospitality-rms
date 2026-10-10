// Shelf life & labels and Breakage (ADR 093): the words and the day-dot colours.

/** How an item is kept (file 10 `storage`). */
export const STORAGE = ['dry', 'chilled', 'frozen'] as const;
export type Storage = (typeof STORAGE)[number];

export const STORAGE_WORDS: Readonly<Record<Storage, string>> = {
  dry: 'Keep dry',
  chilled: 'Keep chilled (0 to 5 °C)',
  frozen: 'Keep frozen (−18 °C or colder)',
};

/**
 * The day-dot colour of each weekday (0 Sunday to 6 Saturday), as kitchens use them: the
 * label's dot is the use-by day's.
 */
export const DAY_DOTS: readonly { day: string; colour: string }[] = [
  { day: 'Sunday', colour: 'black' },
  { day: 'Monday', colour: 'blue' },
  { day: 'Tuesday', colour: 'yellow' },
  { day: 'Wednesday', colour: 'red' },
  { day: 'Thursday', colour: 'green' },
  { day: 'Friday', colour: 'brown' },
  { day: 'Saturday', colour: 'orange' },
];

/** Why it broke (inv.breakage.reason). */
export const BREAKAGE_REASONS = ['dropped', 'washing', 'guest', 'worn_out', 'other'] as const;
export type BreakageReason = (typeof BREAKAGE_REASONS)[number];

export const BREAKAGE_REASON_WORDS: Readonly<Record<BreakageReason, string>> = {
  dropped: 'Dropped',
  washing: 'In washing',
  guest: 'By a guest',
  worn_out: 'Worn out or torn',
  other: 'Other',
};

/** Who broke it (inv.breakage.broken_by). */
export const BROKEN_BY = ['staff', 'guest', 'unknown'] as const;
export type BrokenBy = (typeof BROKEN_BY)[number];

export const BROKEN_BY_WORDS: Readonly<Record<BrokenBy, string>> = {
  staff: 'Someone on the staff',
  guest: 'A guest',
  unknown: 'Not known',
};
