import { TILE_BY_CODE, type ExtraCode } from '@outlet-ops/domain';
import type { OutletChoice } from '@outlet-ops/onboarding/templates';

// The fields of the "Add an outlet" form (ADR 062): the review page and the submit read the
// same ones, from the query string or the posted form.

export type Search = Record<string, string | string[] | undefined>;
const many = (v: string | string[] | undefined) => (v === undefined ? [] : [v].flat());
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/** The choice the form holds so far. */
export function choiceFrom(q: Search, timezone: string): OutletChoice {
  const tile = TILE_BY_CODE.get(one(q.tile));
  return {
    tile: one(q.tile),
    extras: (q.x ? many(q.extra) : (tile?.with ?? [])) as ExtraCode[],
    code: one(q.code).trim().toUpperCase(),
    name: one(q.name).trim(),
    parentCode: one(q.under),
    timezone,
    ...(q.d ? { departments: many(q.dept) } : {}),
    // an unticked box sends nothing: once the form has been sent, absent means no
    items: q.x ? one(q.items) === 'yes' : true,
  };
}
