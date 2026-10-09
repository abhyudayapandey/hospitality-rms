import { describe, expect, it } from 'vitest';
import { emptyDraft, roleQuestions } from '@outlet-ops/onboarding/templates';
import { applyForm, stepAfter, type Fields } from './form';

// The wizard's forms (ADR 064): what each screen's fields change in the draft.

const fields = (pairs: [string, string][]): Fields => {
  const f: Fields = new Map();
  for (const [k, v] of pairs) f.set(k, [...(f.get(k) ?? []), v]);
  return f;
};
let n = 0;
const key = () => `k${++n}`;

describe('the set-up forms', () => {
  it('company: words in, codes upper case, defaults kept', () => {
    const { draft } = applyForm(
      emptyDraft(),
      'company',
      fields([
        ['name', 'Blue Bean'],
        ['code', 'blue-bean'],
        ['ownerName', 'Asha'],
        ['ownerEmail', 'Asha@X.test'],
      ]),
      key,
    );
    expect(draft.company).toMatchObject({
      code: 'BLUE-BEAN',
      ownerEmail: 'asha@x.test',
      timezone: 'Asia/Kolkata',
      isTest: false,
    });
  });

  it('what they buy: a usual bundle unticked stays out; Events & compliance is in only when ticked', () => {
    const withCafe = applyForm(
      emptyDraft(),
      'outlets',
      fields([
        ['op', 'save'],
        ['tile', 'cafe'],
        ['name', 'Bandra Café'],
      ]),
      key,
    ).draft;
    const off = applyForm(
      withCafe,
      'bundles',
      fields([
        ['bundle', 'stock_buying'],
        ['bundle', 'kitchen_bar'],
        ['bundle', 'daily_work'],
        ['bundle', 'events_compliance'],
      ]),
      key,
    ).draft;
    expect(off.bundlesOff).toEqual(['people']);
    expect(off.bundlesOn).toEqual(['events_compliance']);
    const back = applyForm(
      off,
      'bundles',
      fields([
        ['bundle', 'stock_buying'],
        ['bundle', 'kitchen_bar'],
        ['bundle', 'people'],
        ['bundle', 'daily_work'],
      ]),
      key,
    ).draft;
    expect(back.bundlesOff).toEqual([]);
    expect(back.bundlesOn).toEqual([]);
    // the review posts nothing about bundles: nothing changes
    expect(applyForm(off, 'review', fields([]), key).draft.bundlesOff).toEqual(['people']);
  });

  it('outlets: add, change keeps answers, a new kind starts again, remove', () => {
    let d = applyForm(
      emptyDraft(),
      'outlets',
      fields([
        ['op', 'save'],
        ['tile', 'cafe'],
        ['name', 'Bandra'],
        ['extra', 'delivery'],
        ['extra', 'brewery'], // not offered for a café: dropped
      ]),
      key,
    ).draft;
    expect(d.outlets).toHaveLength(1);
    const o = d.outlets[0]!;
    expect(o.extras).toEqual(['delivery']);
    o.roles['BARISTA'] = { mode: 'not_done' };
    d = applyForm(
      d,
      'outlets',
      fields([
        ['op', 'save'],
        ['key', o.key],
        ['tile', 'cafe'],
        ['name', 'Bandra West'],
        ['extra', 'delivery'],
      ]),
      key,
    ).draft;
    expect(d.outlets[0]).toMatchObject({
      name: 'Bandra West',
      roles: { BARISTA: { mode: 'not_done' } },
    });
    d = applyForm(
      d,
      'outlets',
      fields([
        ['op', 'save'],
        ['key', o.key],
        ['tile', 'qsr'],
        ['name', 'Bandra West'],
      ]),
      key,
    ).draft;
    expect(d.outlets[0]!.roles).toEqual({});
    d = applyForm(
      d,
      'outlets',
      fields([
        ['op', 'remove'],
        ['key', o.key],
      ]),
      key,
    ).draft;
    expect(d.outlets).toEqual([]);
  });

  it('roles: covered by needs a role; people rows and a paste', () => {
    let d = applyForm(
      emptyDraft(),
      'outlets',
      fields([
        ['op', 'save'],
        ['tile', 'restaurant'],
        ['name', 'Juhu'],
      ]),
      key,
    ).draft;
    const o = d.outlets[0]!;
    const [a, b] = roleQuestions(d, o);
    d = applyForm(
      d,
      'roles',
      fields([
        [`role:${o.key}:${a!.code}`, 'covered_by'],
        [`by:${o.key}:${a!.code}`, b!.code],
        [`role:${o.key}:${b!.code}`, 'covered_by'],
        [`by:${o.key}:${b!.code}`, ''],
      ]),
      key,
    ).draft;
    expect(d.outlets[0]!.roles).toEqual({
      [a!.code]: { mode: 'covered_by', by: b!.code },
      [b!.code]: { mode: 'have' },
    });
    const r = applyForm(
      d,
      'people',
      fields([
        ['pn', '2'],
        ['p.0.name', 'Ravi'],
        ['p.0.role', b!.code],
        ['p.0.outlet', o.key],
        ['p.1.name', 'Gone'],
        ['p.1.remove', 'yes'],
        ['paste', `Meena, meena@x.test, ${b!.title}, Juhu`],
      ]),
      key,
    );
    expect(r.draft.people.map((p) => [p.name, p.role, p.outlet])).toEqual([
      ['Ravi', b!.code, o.key],
      ['Meena', b!.code, o.key],
    ]);
  });

  it('Back and Next', () => {
    expect(stepAfter('roles', 'next')).toBe('people');
    expect(stepAfter('company', 'back')).toBe('company');
    expect(stepAfter('stock', 'review')).toBe('review');
    expect(stepAfter('stock', 'stay')).toBe('stock');
  });
});
