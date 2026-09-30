import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from './csv';

describe('parseCsv', () => {
  it('reads quoted fields with commas, quotes and line breaks, keeping file line numbers', () => {
    const t = parseCsv('﻿a,b\r\n1,"x, ""y"""\n"multi\nline",2\n\n3,4\n');
    expect(t.header).toEqual(['a', 'b']);
    expect(t.rows).toEqual([
      { line: 2, values: { a: '1', b: 'x, "y"' } },
      { line: 3, values: { a: 'multi\nline', b: '2' } },
      { line: 6, values: { a: '3', b: '4' } },
    ]);
  });

  it('rejects a row with the wrong number of columns, naming its line', () => {
    expect(() => parseCsv('a,b\n1,2\n3\n')).toThrow(new CsvError('expected 2 columns, found 1', 3));
  });

  it('rejects an unclosed quote', () => {
    expect(() => parseCsv('a\n"open\n')).toThrow('a quoted field is not closed');
  });
});
