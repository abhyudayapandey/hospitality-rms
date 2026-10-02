import { describe, expect, it } from 'vitest';
import { groupPlaces } from './place-screens';

describe('place switcher names', () => {
  it('drops the outlet from each name inside one outlet', () => {
    expect(
      groupPlaces([
        { id: '1', name: 'Test Hotel & Bar 1.0', kind: 'outlet' },
        { id: '2', name: 'Test Hotel & Bar 1.0 – Kitchen' },
      ]),
    ).toEqual([
      {
        label: null,
        options: [
          { id: '1', name: 'Test Hotel & Bar 1.0', short: 'Whole outlet' },
          { id: '2', name: 'Test Hotel & Bar 1.0 – Kitchen', short: 'Kitchen' },
        ],
      },
    ]);
  });

  it('groups by outlet when there are several; a lone outlet keeps its name', () => {
    expect(
      groupPlaces([
        { id: '1', name: 'Test Bar 3.0 – Bar Store (view only)' },
        { id: '2', name: 'Test Bar 3.0 – Kitchen Store (view only)' },
        { id: '3', name: 'Test Guest House 2.0', kind: 'outlet' },
      ]),
    ).toEqual([
      {
        label: 'Test Bar 3.0',
        options: [
          { id: '1', name: 'Test Bar 3.0 – Bar Store (view only)', short: 'Bar Store (view only)' },
          {
            id: '2',
            name: 'Test Bar 3.0 – Kitchen Store (view only)',
            short: 'Kitchen Store (view only)',
          },
        ],
      },
      {
        label: null,
        options: [{ id: '3', name: 'Test Guest House 2.0', short: 'Test Guest House 2.0' }],
      },
    ]);
  });
});
