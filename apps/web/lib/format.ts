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
 * When something happened, in one short style (UX review U-25): "today, 2:54 pm",
 * "yesterday, 9:10 am", else "2 Oct, 2:54 pm". Times are the outlet's (Asia/Kolkata).
 */
export function formatWhen(d: Date | string, now: Date = new Date()): string {
  const tz = 'Asia/Kolkata';
  const at = new Date(d);
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(x);
  const time = new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  }).format(at);
  if (day(at) === day(now)) return `today, ${time}`;
  if (day(at) === day(new Date(now.getTime() - 86_400_000))) return `yesterday, ${time}`;
  const date = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: tz,
  }).format(at);
  return `${date}, ${time}`;
}
