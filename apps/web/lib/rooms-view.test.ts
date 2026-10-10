import { describe, expect, it } from 'vitest';
import { byFloor, floorName, ROOM_STATUSES, ROOM_TONE, roomStatus } from './rooms-view';

// Room status for people who read little (ADR 104): a word, a colour and a picture, never
// the hotel's code.
describe('room statuses', () => {
  it('each has a plain word, its own colour and picture; no word is a code', () => {
    for (const s of ROOM_STATUSES) {
      expect(s.word).not.toMatch(/^[A-Z]{2,3}$/);
      expect(s.word).not.toContain(s.code);
      expect(ROOM_TONE[s.tone]).toBeTruthy();
    }
    expect(new Set(ROOM_STATUSES.map((s) => s.tone)).size).toBe(ROOM_STATUSES.length);
    expect(new Set(ROOM_STATUSES.map((s) => s.icon)).size).toBe(ROOM_STATUSES.length);
  });
  it('a room with no status is clean', () => {
    expect(roomStatus(null).word).toBe('Clean');
    expect(roomStatus('VD').word).toBe('Dirty');
    expect(roomStatus('OCC').word).toBe('Guest in');
  });
  it('rooms by floor, in order; a floor that is a word keeps its name', () => {
    const g = byFloor([
      { n: '101', floor: '1' },
      { n: '201', floor: '2' },
      { n: '102', floor: '1' },
      { n: 'P-10', floor: 'Pool level' },
    ]);
    expect(g.map((f) => [floorName(f.floor), f.rooms.map((r) => r.n)])).toEqual([
      ['Floor 1', ['101', '102']],
      ['Floor 2', ['201']],
      ['Pool level', ['P-10']],
    ]);
    expect(floorName('')).toBe('Rooms');
  });
});
