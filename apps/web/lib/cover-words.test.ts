import { describe, expect, it } from 'vitest';
import { answerWords, outcomeLines, savedMessage } from './cover-words';

// Admin → Who does what (ADR 065): the words, never a code.

describe('answerWords', () => {
  it('says each answer as people do', () => {
    expect(answerWords({ answer: 'have', covered_by_name: null, people: 2 })).toBe(
      'We have it · 2 people',
    );
    expect(answerWords({ answer: 'have', covered_by_name: null, people: 0 })).toBe(
      'We have it · nobody here yet',
    );
    expect(
      answerWords({ answer: 'covered_by', covered_by_name: 'Executive Chef', people: 0 }),
    ).toBe('Someone else does it: Executive Chef');
    expect(answerWords({ answer: 'not_done', covered_by_name: null, people: 1 })).toBe(
      "We don't do this",
    );
  });
});

describe('savedMessage', () => {
  it('never says the cover works while access waits for approval', () => {
    expect(savedMessage({ changed: true, pending: 2, people: [{ name: 'GM', waiting: 2 }] })).toBe(
      "Saved. 2 access changes are waiting for approval, so the cover isn't fully working yet.",
    );
    expect(savedMessage({ changed: true, pending: 0, people: [{ name: 'A', waiting: 0 }] })).toBe(
      'Saved. Access changed at once for 1 person.',
    );
    expect(savedMessage({ changed: false })).toBe("Nothing to change: that's how it is now.");
  });
});

describe('outcomeLines', () => {
  it('names whose access changes and where the tasks go', () => {
    expect(
      outcomeLines(
        {
          changed: true,
          people: [
            { name: 'Test Executive Chef 1.1', waiting: 0 },
            { name: 'Test General Manager 2.0', waiting: 1 },
          ],
          tasks_returned: 1,
          tasks_given: 2,
        },
        { answer: 'covered_by', role: 'Sous Chef', by: 'Executive Chef' },
      ),
    ).toEqual([
      'Their access changes at once: Test Executive Chef 1.1.',
      'Test General Manager 2.0: 1 access change waits for approval.',
      '1 unstarted task moves to the Executive Chef.',
      '2 tasks due now go to the Executive Chef on duty.',
    ]);
  });

  it('"We don\'t do this" counts the open tasks that stay unassigned', () => {
    expect(
      outcomeLines(
        { changed: true, people: [], tasks_returned: 1, tasks_open: 3 },
        { answer: 'not_done', role: 'Store Keeper', by: null },
      ),
    ).toEqual([
      "Nobody's access changes.",
      "1 unstarted task goes back to the Store Keeper's To do list.",
      '3 open tasks stay unassigned; nothing is cancelled.',
    ]);
  });
});
