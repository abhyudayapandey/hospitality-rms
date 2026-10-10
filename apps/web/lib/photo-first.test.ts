import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A photo is part of doing the job, so its control sits above the button that saves, finishes
// or sends (Next, Save, Done, Mark fixed, Record...), never below it (ADR 098). Every form that
// takes a photo or a file keeps one: no photo control comes after the form's last main button.

const APP = join(import.meta.dirname, '..', 'app');
const PHOTO = /<(PhotoField|AddTaskPhoto|BillFiles|DocumentFiles)\b/g;
const BUTTON = /className=\{primaryButton\}/g;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.tsx') ? [join(dir, d.name)] : [],
  );
}

describe('photos come before the button', () => {
  const forms = files(APP)
    .map((f) => ({ f, s: readFileSync(f, 'utf8') }))
    .filter(({ s }) => s.match(PHOTO) && s.match(BUTTON));

  it('finds the forms that take photos', () => {
    expect(forms.length).toBeGreaterThanOrEqual(8);
  });

  it.each(forms.map(({ f, s }) => [f.slice(APP.length + 1), s]))('%s', (_name, s) => {
    const photos = [...s.matchAll(PHOTO)].map((m) => m.index);
    const buttons = [...s.matchAll(BUTTON)].map((m) => m.index);
    expect(Math.max(...photos)).toBeLessThan(Math.max(...buttons));
  });
});
