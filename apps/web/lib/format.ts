import { addDays, businessDate, formatTime } from './dates';

export function processLabel(processType: string): string {
  return processType
    .toLowerCase()
    .split('_')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

export function formatMoney(amount: string | number | null, currency = 'INR'): string | null {
  if (amount === null) return null;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amount));
}

/**
 * When something happened or is due, in one short style (UX review U-25): "today, 14:54",
 * "yesterday, 09:10", "tomorrow, 07:00", else "2 Oct, 14:54". Times are the outlet's (Asia/Kolkata), on the
 * 24-hour clock, and "today" is the 04:00 business day (ADR 148).
 */
export function formatWhen(d: Date | string, now: Date = new Date()): string {
  const tz = 'Asia/Kolkata';
  const at = new Date(d);
  const time = formatTime(at, tz);
  const today = businessDate(now, tz);
  const day = businessDate(at, tz);
  if (day === today) return `today, ${time}`;
  if (day === addDays(today, -1)) return `yesterday, ${time}`;
  if (day === addDays(today, 1)) return `tomorrow, ${time}`;
  const date = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: tz,
  }).format(at);
  return `${date}, ${time}`;
}

/** '50 portions', '1 portion', '12.5 portions' (ADR 084): what a batch, or a prep task, makes. */
export function portionsText(n: string | number): string {
  const v = Math.round(Number(n) * 10) / 10;
  return `${v.toLocaleString('en-IN')} portion${v === 1 ? '' : 's'}`;
}
