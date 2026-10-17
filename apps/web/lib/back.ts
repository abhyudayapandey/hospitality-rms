// "← Back" returns to the list as it was, its tab and "All stores" included (ADR 053): a list
// passes its own address to the detail page as ?back=, and the detail page uses it only when
// it is a path inside the app (never another site).

/** The detail page's address with the list it came from. */
export function withBack(href: string, back: string): string {
  return `${href}${href.includes('?') ? '&' : '?'}back=${encodeURIComponent(back)}`;
}

// below 0x20 and DEL: browsers drop tab, CR and LF from a URL, so "/\t/evil.example" is
// "//evil.example", another site (ADR 166)
// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Whether `p` is a path inside this app: one leading slash, never another site. */
export function isAppPath(p: string | null | undefined): p is string {
  if (!p || !p.startsWith('/')) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return false;
  }
  for (const s of [p, decoded]) {
    if (s.startsWith('//') || s.includes('\\') || CONTROL.test(s)) return false;
  }
  try {
    const base = 'http://app.invalid';
    const u = new URL(p, base);
    return u.origin === base && u.pathname.startsWith('/');
  } catch {
    return false;
  }
}

/** Where "← Back" goes: the list it came from when that is an app path, else `fallback`. */
export function backHref(back: string | null | undefined, fallback: string): string {
  return isAppPath(back) ? back : fallback;
}
