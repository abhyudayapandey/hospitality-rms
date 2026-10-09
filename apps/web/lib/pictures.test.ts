import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PICTURE_KEYS } from '@outlet-ops/domain';
import { describe, expect, it } from 'vitest';

// Every picture in the catalogue has its file, and every file is in the catalogue (ADR 084):
// `pnpm --filter @outlet-ops/web pictures` writes them.
const DIR = join(import.meta.dirname, '..', 'public', 'pictures');

describe('the picture files', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.svg'));

  it('match the catalogue one for one', () => {
    expect(files.map((f) => f.replace(/\.svg$/, '')).sort()).toEqual([...PICTURE_KEYS].sort());
  });

  it('are small 32 x 32 SVGs with no script and no outside link', () => {
    for (const f of files) {
      const s = readFileSync(join(DIR, f), 'utf8');
      expect([f, /viewBox="0 0 32 32"/.test(s)]).toEqual([f, true]);
      expect([f, /<script|href="http|xlink:href="http/i.test(s)]).toEqual([f, false]);
      expect([f, s.length < 40_000]).toEqual([f, true]);
    }
  });

  it('carry the Fluent Emoji licence beside them', () => {
    expect(readFileSync(join(DIR, 'LICENSE-fluent-emoji.txt'), 'utf8')).toContain('MIT License');
  });
});
