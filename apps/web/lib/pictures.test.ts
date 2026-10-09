import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PICTURE_KEYS } from '@outlet-ops/domain';
import { describe, expect, it } from 'vitest';
import { PICTURE_CREDITS } from './picture-credits';
import { PICTURE_PHOTOS } from './picture-photos';

// The photo library (ADR 084): every photo is for a picture in the catalogue, has its file and
// its credit (author, licence, source), and no file is left without one.
const DIR = join(import.meta.dirname, '..', 'public', 'pictures');

describe('the photo library', () => {
  it('names only pictures in the catalogue, each with its small file', () => {
    const keys = new Set(PICTURE_KEYS);
    for (const [key, file] of PICTURE_PHOTOS) {
      expect([key, keys.has(key)]).toEqual([key, true]);
      expect([file, existsSync(join(DIR, file))]).toEqual([file, true]);
      expect([file, statSync(join(DIR, file)).size < 60_000]).toEqual([file, true]);
    }
  });

  it('credits every photo, and has no file that is not in the library', () => {
    const credited = new Set(PICTURE_CREDITS.map((c) => c.key));
    expect([...PICTURE_PHOTOS.keys()].filter((k) => !credited.has(k))).toEqual([]);
    for (const c of PICTURE_CREDITS) {
      expect([c.key, c.author.length > 0, c.licence.length > 0]).toEqual([c.key, true, true]);
      expect(c.source).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
    }
    const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.webp')) : [];
    const used = new Set(PICTURE_PHOTOS.values());
    expect(files.filter((f) => !used.has(f))).toEqual([]);
  });
});
