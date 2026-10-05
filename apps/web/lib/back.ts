// "← Back" returns to the list as it was, its tab and "All stores" included (ADR 053): a list
// passes its own address to the detail page as ?back=, and the detail page uses it only when
// it is a path inside the app (never another site).

/** The detail page's address with the list it came from. */
export function withBack(href: string, back: string): string {
  return `${href}${href.includes('?') ? '&' : '?'}back=${encodeURIComponent(back)}`;
}

/** Where "← Back" goes: the list it came from when that is an app path, else `fallback`. */
export function backHref(back: string | null | undefined, fallback: string): string {
  if (!back || !back.startsWith('/') || back.startsWith('//') || back.includes('\\')) {
    return fallback;
  }
  return back;
}
