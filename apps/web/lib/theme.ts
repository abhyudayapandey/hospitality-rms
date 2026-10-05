// Dark or light (ADR 052). Dark is the default; the person's choice is kept on the device
// (localStorage) and set on <html data-theme> before the first paint, so a page never flashes
// the other theme. Nothing about it reaches the server.

export type Theme = 'dark' | 'light';
export const THEME_KEY = 'outlet-ops-theme';
export const DEFAULT_THEME: Theme = 'dark';

export const asTheme = (v: string | null | undefined): Theme =>
  v === 'light' ? 'light' : DEFAULT_THEME;

/** Runs inline in <head>: the stored choice, else the default. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');document.documentElement.dataset.theme=t==='light'?'light':'${DEFAULT_THEME}'}catch(e){}`;
