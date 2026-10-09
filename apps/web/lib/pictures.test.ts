import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PICTURE_KEYS } from '@outlet-ops/domain';
import { describe, expect, it } from 'vitest';
import { PICTURE_PHOTOS } from './picture-photos';

// Every photo in the library is for a picture in the catalogue and has its file (ADR 084).
const DIR = join(import.meta.dirname, '..', 'public', 'pictures');

describe('the photo library', () => {
  it('names only pictures in the catalogue, each with its file', () => {
    const keys = new Set(PICTURE_KEYS);
    for (const [key, file] of PICTURE_PHOTOS) {
      expect([key, keys.has(key)]).toEqual([key, true]);
      expect([file, existsSync(join(DIR, file))]).toEqual([file, true]);
    }
  });
});
