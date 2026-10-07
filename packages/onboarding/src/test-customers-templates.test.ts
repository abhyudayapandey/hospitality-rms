import { join } from 'node:path';
import {
  CHECKLIST_BY_CODE,
  EXTRA_BY_CODE,
  TEMPLATE_BY_FORMAT,
  TILES,
  type OutletFormat,
} from '@outlet-ops/domain';
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { readCustomerDir } from './dir';

// The test customers follow the SOPs through the templates (ADR 066): every department of a
// test outlet is one its template has, every role its people hold is one its template (or an
// extra it offers) expects, and every library checklist copy names a library checklist. A
// template or the test data drifting apart fails here. Allowed differences are listed with
// their reason.

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');
const rows = (files: Record<string, string>, prefix: string) =>
  parseCsv(files[Object.keys(files).find((f) => f.startsWith(prefix))!]!).rows.map((r) => r.values);

/** What a template can give an outlet of that format: with every extra its tiles offer. */
function offered(format: OutletFormat) {
  const t = TEMPLATE_BY_FORMAT.get(format)!;
  const extras = [...new Set(TILES.filter((x) => x.format === format).flatMap((x) => x.offers))]
    .map((x) => EXTRA_BY_CODE.get(x)!)
    .filter((e) => !e.site);
  return {
    departments: new Set([
      ...t.departments.map((d) => d.code),
      ...extras.flatMap((e) => e.departments ?? []),
    ]),
    roles: new Set([...t.roles, ...extras.flatMap((e) => e.roles ?? [])].map((r) => r.code)),
  };
}

const CENTRAL = EXTRA_BY_CODE.get('central_kitchen')!;

describe.each(['test-company', 'test-solo-bar-co'])('%s follows its templates', (customer) => {
  const files = readCustomerDir(join(DATA, customer));
  const org = rows(files, '01_');
  const users = rows(files, '07_');
  const outlets = org.filter((r) => r['kind'] === 'outlet' || r['kind'] === 'site');
  const placesOf = (code: string) =>
    new Set([code, ...org.filter((r) => r['parent_code'] === code).map((r) => r['node_code']!)]);

  it.each(outlets.map((o) => o['node_code']!))('%s', (code) => {
    const outlet = org.find((r) => r['node_code'] === code)!;
    const site = outlet['kind'] === 'site';
    const t = site
      ? { departments: null, roles: new Set(CENTRAL.roles!.map((r) => r.code)) }
      : offered(outlet['outlet_format'] as OutletFormat);
    const depts = org
      .filter((r) => r['parent_code'] === code && r['kind'] === 'department')
      .map((r) => r['node_code']!.slice(code.length + 1));
    if (t.departments) {
      expect(
        depts.filter((d) => !t.departments.has(d)),
        'departments',
      ).toEqual([]);
    }
    const places = placesOf(code);
    const roles = [
      ...new Set(
        users.filter((u) => places.has(u['home_node_code']!)).map((u) => u['job_role_code']!),
      ),
    ];
    expect(roles.length, 'people').toBeGreaterThan(0);
    expect(
      roles.filter((r) => !t.roles.has(r)),
      'roles the template lacks',
    ).toEqual([]);
  });

  it('every library checklist copy names a library checklist and version', () => {
    for (const r of rows(files, '29_')) {
      if (!r['from_library']) continue;
      const [lib, version] = r['from_library'].split('@');
      expect(CHECKLIST_BY_CODE.get(lib!)?.version, r['from_library']).toBe(Number(version));
    }
  });
});

describe('allowed differences', () => {
  it('Guest House 2.0 is a small hotel with no departments: everyone works at the outlet', () => {
    const org = rows(readCustomerDir(join(DATA, 'test-company')), '01_');
    expect(org.filter((r) => r['parent_code'] === 'TEST-GUEST-HOUSE-2.0')).toEqual([]);
  });
});
