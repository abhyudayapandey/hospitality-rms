import { describe, expect, it } from 'vitest';
import { CHECKLISTS } from './checklists';
import { isTaskIcon, stepIcon, TASK_ICON_WORDS, TASK_ICONS, taskIcon } from './task-icons';

// Every task and step has a picture (ADR 079): the one it names, else one from its words.

describe('task and step icons', () => {
  it('every icon has words for the picker, and no name twice', () => {
    expect(new Set(TASK_ICONS).size).toBe(TASK_ICONS.length);
    for (const i of TASK_ICONS) expect(TASK_ICON_WORDS[i]).toBeTruthy();
    expect(isTaskIcon('mop')).toBe(true);
    expect(isTaskIcon('rocket')).toBe(false);
  });

  it('picks from the words, the most particular first', () => {
    expect(stepIcon('Walk-in chiller temperature', 'number')).toBe('thermometer');
    expect(stepIcon('Mop the kitchen floor', 'tick')).toBe('mop');
    expect(stepIcon('Hand-wash station stocked', 'tick')).toBe('handwash');
    expect(stepIcon('Fryer oil checked', 'tick')).toBe('oil');
    expect(stepIcon('Restock the back bar to par', 'tick')).toBe('bottle');
    expect(stepIcon('Fire exits clear', 'tick')).toBe('extinguisher');
    expect(stepIcon('Something new', 'number')).toBe('thermometer');
    expect(stepIcon('Something new', 'tick')).toBe('check');
  });

  it('a named icon wins; an unknown name does not', () => {
    expect(stepIcon('Mop the floor', 'tick', 'bucket')).toBe('mop');
    expect(stepIcon('Mop the floor', 'tick', 'broom')).toBe('broom');
  });

  it('every step of every library checklist has a picture of its own, not the plain tick', () => {
    for (const c of CHECKLISTS) {
      for (const s of c.steps) {
        expect(stepIcon(s.label, s.kind, s.icon), `${c.code}: ${s.label}`).not.toBe('check');
      }
    }
  });

  it('a task by its kind, else its title', () => {
    expect(taskIcon('Makhani gravy', 'prep')).toBe('pot');
    expect(taskIcon('Refill minibar, room 104', 'minibar_refill')).toBe('fridge');
    expect(taskIcon('Bill room 104: 1 beer', 'minibar_bill')).toBe('bill');
    expect(taskIcon('Kitchen opening', 'checklist')).toBe('clipboard');
    expect(taskIcon('Fix the leaking tap', 'one_off')).toBe('tap');
  });
});
