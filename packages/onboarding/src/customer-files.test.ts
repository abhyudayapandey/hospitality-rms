import { describe, expect, it } from 'vitest';
import { withLiveCovers } from './customer-files';

// The console's current files carry the live covers (ADR 065), not the last upload's file 37.

const header = 'outlet_code,job_role_code,mode,covered_by_role\n';
const gm = {
  outlet_code: 'GH',
  job_role_code: 'STORE_KEEPER',
  mode: 'covered_by',
  covered_by_role: 'GENERAL_MANAGER',
};

describe('withLiveCovers', () => {
  it('replaces the uploaded file 37 with the live covers', () => {
    const files = {
      'x/00_customer.csv': 'a',
      'x/37_role_cover.csv': `${header}GH,COOK,not_done,\n`,
    };
    expect(withLiveCovers(files, [gm])).toEqual({
      'x/00_customer.csv': 'a',
      'x/37_role_cover.csv': `${header}GH,STORE_KEEPER,covered_by,GENERAL_MANAGER\n`,
    });
    // every cover removed in Admin: the file stays, empty, so the import removes none back
    expect(withLiveCovers(files, [])['x/37_role_cover.csv']).toBe(header);
  });

  it('adds it beside file 00 when covers exist, and leaves the files alone when none do', () => {
    const files = { 'x/00_customer.csv': 'a' };
    expect(withLiveCovers(files, [{ ...gm, mode: 'not_done', covered_by_role: null }])).toEqual({
      'x/00_customer.csv': 'a',
      'x/37_role_cover.csv': `${header}GH,STORE_KEEPER,not_done,\n`,
    });
    expect(withLiveCovers(files, [])).toBe(files);
  });
});
