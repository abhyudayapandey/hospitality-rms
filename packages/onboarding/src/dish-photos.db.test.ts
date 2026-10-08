import { join } from 'node:path';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCustomer } from './apply';
import { readCustomerDir, readCustomerPhotos } from './dir';

// A dish's photo and method from the onboarding files (ADR 078): photos/menu/<code>.<ext>
// beside the files, and file 24's recipe_for_kind = menu. A dry run counts the photos and
// stores nothing; an applied load stores each new one (its key comes from its content), and
// the same picture again changes nothing. A photo for no dish, or one that is not a picture,
// is a problem in the report and nothing is loaded.

afterAll(closePools);

const DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'onboarding',
  'test-data',
  'test-company',
);
const files = readCustomerDir(DIR);
const photos = readCustomerPhotos(DIR);

describe('dish photos and methods in the onboarding files', () => {
  it('the test company carries one photo and two dishes with a method', () => {
    expect(Object.keys(photos)).toEqual(['BUTTER-CHICKEN.jpg']);
    expect(files['24_prep_procedures.csv']).toContain('BUTTER-CHICKEN,menu,1,');
  });

  it('a dry run stores nothing; the same files again change nothing', async () => {
    await inRolledBackTx(async (c) => {
      const stored: string[] = [];
      const putPhoto = (key: string) => {
        stored.push(key);
        return Promise.resolve();
      };
      const dry = await loadCustomer(c, files, { nested: true, dryRun: true, photos, putPhoto });
      expect(dry.issues).toEqual([]);
      expect(dry.counts['dish photos']).toEqual({ created: 0, updated: 0, unchanged: 1 });
      expect(dry.counts['dish methods']?.unchanged).toBe(5);
      expect(stored).toEqual([]);
    });
  });

  it('a new picture replaces the photo, stored under a key of its own', async () => {
    await inRolledBackTx(async (c) => {
      const stored: { key: string; type: string }[] = [];
      const other = new Uint8Array([...photos['BUTTER-CHICKEN.jpg']!, 0]);
      const r = await loadCustomer(c, files, {
        nested: true,
        photos: { 'butter-chicken.jpg': other },
        putPhoto: (key, _bytes, type) => {
          stored.push({ key, type });
          return Promise.resolve();
        },
      });
      expect(r.issues).toEqual([]);
      expect(r.counts['dish photos']).toEqual({ created: 0, updated: 1, unchanged: 0 });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.type).toBe('image/jpeg');
      const { rows } = await c.query<{ photo_key: string }>(
        `select m.photo_key from menu.menu_item m join core.tenant t on t.id = m.tenant_id
          where t.code = 'TEST-COMPANY' and m.code = 'BUTTER-CHICKEN'`,
      );
      expect(rows[0]!.photo_key).toBe(stored[0]!.key);
      expect(stored[0]!.key).toMatch(/^items\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/);
    });
  });

  it('a photo for no dish, or one that is not a picture, stops the load', async () => {
    await inRolledBackTx(async (c) => {
      const putPhoto = () => Promise.reject(new Error('nothing is stored'));
      const nobody = await loadCustomer(c, files, {
        nested: true,
        photos: { 'NO-SUCH-DISH.jpg': photos['BUTTER-CHICKEN.jpg']! },
        putPhoto,
      });
      expect(nobody.applied).toBe(false);
      expect(nobody.issues).toEqual([
        {
          file: 'photos/menu/NO-SUCH-DISH.jpg',
          message: 'no dish NO-SUCH-DISH in 22_menu_items.csv',
        },
      ]);
      const fake = await loadCustomer(c, files, {
        nested: true,
        photos: { 'BUTTER-CHICKEN.jpg': new TextEncoder().encode('<svg/>') },
        putPhoto,
      });
      expect(fake.applied).toBe(false);
      expect(fake.issues[0]!.file).toBe('photos/menu');
    });
  });

  it('file 24 names a dish only from file 22', async () => {
    await inRolledBackTx(async (c) => {
      const r = await loadCustomer(
        c,
        {
          ...files,
          '24_prep_procedures.csv': `${files['24_prep_procedures.csv']}NO-SUCH-DISH,menu,1,Plate it.,1\n`,
        },
        { nested: true, dryRun: true },
      );
      expect(r.issues).toEqual([
        expect.objectContaining({
          file: '24_prep_procedures.csv',
          column: 'prep_item_code',
          message: 'NO-SUCH-DISH is not in 22_menu_items.csv',
        }),
      ]);
    });
  });
});
