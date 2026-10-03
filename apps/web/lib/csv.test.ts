import { describe, expect, it } from 'vitest';
import { csvCell, csvName, toCsv } from './csv';

describe('csv', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('Test Supplier – Dairy & Poultry')).toBe('Test Supplier – Dairy & Poultry');
    expect(csvCell('Onions, red')).toBe('"Onions, red"');
    expect(csvCell('5" plates')).toBe('"5"" plates"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
  });

  it('never lets a cell run as a formula; numbers stay numbers', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('+91 98200 10001')).toBe("'+91 98200 10001");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('-16.42')).toBe('-16.42');
    expect(csvCell(-3)).toBe('-3');
  });

  it('a header and rows, CRLF line ends', () => {
    expect(
      toCsv(
        ['outlet', 'sales'],
        [
          ['Test Bar 3.0', '1200.00'],
          ['Test Hotel & Bar 1.0', null],
        ],
      ),
    ).toBe('outlet,sales\r\nTest Bar 3.0,1200.00\r\nTest Hotel & Bar 1.0,\r\n');
  });

  it('file names', () => {
    expect(csvName('league', 'Test Area Mumbai', '2026-09-27', '2026-10-03')).toBe(
      'league-test-area-mumbai-2026-09-27-2026-10-03.csv',
    );
  });
});
