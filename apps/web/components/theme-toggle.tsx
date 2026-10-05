'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { asTheme, THEME_KEY, type Theme } from '@/lib/theme';

/** Dark or light, next to Notifications (ADR 052): shows the theme a tap switches to. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => setTheme(asTheme(document.documentElement.dataset.theme)), []);
  const next: Theme = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      type="button"
      data-testid="theme-toggle"
      aria-label={next === 'light' ? 'Light view' : 'Dark view'}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // private mode: the choice lasts this page only
        }
        setTheme(next);
      }}
      className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-700"
    >
      <Icon name={next === 'light' ? 'sun' : 'moon'} />
    </button>
  );
}
