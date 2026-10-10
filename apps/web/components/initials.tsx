/** "Priya Menon" → "PM" (UX-6: a face for the person, not a sign-out button). */
export function initials(name: string): string {
  const parts = name.split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

/** A round badge with a person's initials, as in the header (ADR 108): people rows. */
export function Initials({ name, className = 'size-9' }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      data-testid="initials"
      className={`flex shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-700 ${className}`}
    >
      {initials(name)}
    </span>
  );
}
