import { describe, expect, it } from 'vitest';
import { humanizeCode, titleOf } from './job-roles';

describe('job role titles', () => {
  it('uses the customer’s title, else a readable form of the code', () => {
    const t = titleOf(new Map([['FANDB_MANAGER', 'F&B Manager']]));
    expect(t('FANDB_MANAGER')).toBe('F&B Manager');
    expect(t('fandb_manager')).toBe('F&B Manager');
    expect(t('CHEF_DE_PARTIE')).toBe('Chef de partie');
    expect(t(null)).toBe('');
    expect(humanizeCode('ROOM_ATTENDANT')).toBe('Room attendant');
  });
});
