import { describe, expect, it } from 'vitest';
import { asTheme, DEFAULT_THEME, THEME_SCRIPT } from './theme';

describe('theme', () => {
  it('is dark unless light was chosen', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(asTheme(null)).toBe('dark');
    expect(asTheme('nonsense')).toBe('dark');
    expect(asTheme('light')).toBe('light');
  });
  it('the head script never throws without storage', () => {
    expect(THEME_SCRIPT).toMatch(/^try\{/);
  });
});
