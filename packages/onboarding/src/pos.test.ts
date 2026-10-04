import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { csvRows, datesIn, PosFileError, readPosFile } from './pos';

// The POS's "Sale by item" export (ADR 039), laid out as the IDSNEXT sample is.
const SAMPLE = [
  'Sale by item,,,,,',
  'From 01/07/2026 To 01/07/2026,,,,,',
  'Item,Description,Quantity,Rate,Value,Discount',
  'LE CAFE,,,,,',
  'Food,,,,,',
  '1023,FRENCH FRIES ..........,4.000,200.00,760.00,40.00',
  '1024,PANEER TIKKA ..........,2.000,355.00,710.00,0.00',
  '1024,PANEER TIKKA ..........,1.000,300.00,300.00,0.00',
  'Item Total,,3.000,,1010.00,0.00',
  'Group Total,,7.000,,1770.00,40.00',
  'Menu Type Total,,7.000,,1770.00,40.00',
  'Liquor,,,,,',
  '2001,"MOJITO, CLASSIC",3.000,430.00,"1,290.00",0.00',
  '2002,HOUSE WINE (COMP),1.000,380.00,0.00,380.00',
  'Menu Type Total,,4.000,,1290.00,380.00',
  'Restaurant Total,,11.000,,3060.00,420.00',
  'LE CAFE TAKE AWAY & DELIVERY,,,,,',
  'Food,,,,,',
  '1023,FRENCH FRIES ..........,1.000,200.00,200.00,0.00',
  'Menu Type Total,,1.000,,200.00,0.00',
  'Restaurant Total,,1.000,,200.00,0.00',
  'Grand Total,,12.000,,3260.00,420.00',
].join('\r\n');

const csv = (text: string, name = 'sale_by_item.csv') => readPosFile(name, strToU8(text));
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof PosFileError ? err.code : String(err);
  }
  return 'no error';
};

describe('readPosFile (CSV)', () => {
  it('reads the lines, skipping the total rows, one line per POS code', () => {
    const f = csv(SAMPLE);
    expect(f.lines).toEqual([
      { code: '1023', description: 'FRENCH FRIES', qty: 5, value: 960, discount: 40 },
      { code: '1024', description: 'PANEER TIKKA', qty: 3, value: 1010, discount: 0 },
      { code: '2001', description: 'MOJITO, CLASSIC', qty: 3, value: 1290, discount: 0 },
      { code: '2002', description: 'HOUSE WINE (COMP)', qty: 1, value: 0, discount: 380 },
    ]);
    expect(f.totalValue).toBe(3260);
    expect(f.totalDiscount).toBe(420);
    expect(f.posOutlets).toEqual(['LE CAFE', 'LE CAFE TAKE AWAY & DELIVERY']);
    expect([f.periodFrom, f.periodTo]).toEqual(['2026-07-01', '2026-07-01']);
  });

  it('reads the period of a month-long file', () => {
    const f = csv(
      SAMPLE.replace('From 01/07/2026 To 01/07/2026', 'From 01-Jul-2026 To 31-Jul-2026'),
    );
    expect([f.periodFrom, f.periodTo]).toEqual(['2026-07-01', '2026-07-31']);
  });

  it('refuses lines that do not add up to the Grand Total', () => {
    expect(
      code(() =>
        csv(SAMPLE.replace('Grand Total,,12.000,,3260.00', 'Grand Total,,12.000,,3261.00')),
      ),
    ).toBe('POS_TOTALS_MISMATCH');
  });

  it('refuses a file without the table, without a Grand Total, or with a bad number', () => {
    expect(code(() => csv('Sale by item\nnothing here\n'))).toBe('POS_NO_HEADER');
    expect(code(() => csv(SAMPLE.split('\r\n').slice(0, -1).join('\n')))).toBe(
      'POS_NO_GRAND_TOTAL',
    );
    expect(code(() => csv(SAMPLE.replace('4.000,200.00,760.00', 'four,200.00,760.00')))).toBe(
      'POS_BAD_NUMBER',
    );
    expect(
      code(() =>
        csv(
          SAMPLE.split('\r\n')
            .filter((l) => !/^\d/.test(l))
            .join('\n'),
        ),
      ),
    ).toBe('POS_NO_LINES');
  });

  it('refuses other files', () => {
    expect(code(() => readPosFile('notes.pdf', strToU8('%PDF-1.4')))).toBe('POS_FILE_TYPE');
    expect(code(() => readPosFile('empty.csv', new Uint8Array()))).toBe('POS_FILE_EMPTY');
    expect(code(() => readPosFile('big.csv', new Uint8Array(6 * 1024 * 1024)))).toBe(
      'POS_FILE_TOO_LARGE',
    );
    expect(code(() => readPosFile('broken.xlsx', strToU8('PK not really a zip')))).toBe(
      'POS_FILE_TYPE',
    );
  });
});

/** A minimal .xlsx: shared strings, numbers and an inline string, as Excel writes them. */
function xlsx(rows: (string | number)[][]): Uint8Array {
  const strings: string[] = [];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cells = rows
    .map((r, i) => {
      const cs = r
        .map((v, j) => {
          if (v === '') return '';
          const ref = `${String.fromCharCode(65 + j)}${i + 1}`;
          if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
          if (j === 1 && i === 5)
            return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
          strings.push(v);
          return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
        })
        .join('');
      return `<row r="${i + 1}">${cs}</row>`;
    })
    .join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(
      '<workbook xmlns:r="r"><sheets><sheet name="Sale by item" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/sharedStrings.xml': strToU8(
      `<sst>${strings.map((s) => `<si><r><t>${esc(s.slice(0, 2))}</t></r><r><t xml:space="preserve">${esc(s.slice(2))}</t></r></si>`).join('')}</sst>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${cells}</sheetData></worksheet>`),
  });
}

describe('readPosFile (Excel)', () => {
  it('reads the first sheet: shared and inline strings, numeric codes', () => {
    const f = readPosFile(
      'Sale by item.xlsx',
      xlsx([
        ['Sale by item - 04/10/2026'],
        [],
        ['Item', 'Description', 'Quantity', 'Rate', 'Value', 'Discount'],
        ['TEST BAR 3.0'],
        ['Food'],
        [3001.0, 'PANEER TIKKA & MINT ....', 2, 355, 650, 60],
        [3022, 'MOJITO', 3, 430, 1290, 0],
        ['Menu Type Total', '', 5, '', 1940, 60],
        ['Grand Total', '', 5, '', 1940, 60],
      ]),
    );
    expect(f.lines).toEqual([
      { code: '3001', description: 'PANEER TIKKA & MINT', qty: 2, value: 650, discount: 60 },
      { code: '3022', description: 'MOJITO', qty: 3, value: 1290, discount: 0 },
    ]);
    expect(f.posOutlets).toEqual(['TEST BAR 3.0']);
    expect(f.periodFrom).toBe('2026-10-04');
  });
});

describe('helpers', () => {
  it('finds dates, day first', () => {
    expect(datesIn('From 01/07/2026 To 31.07.2026')).toEqual(['2026-07-01', '2026-07-31']);
    expect(datesIn('1 July 2026 - 2026-07-02')).toEqual(['2026-07-02', '2026-07-01']);
    expect(datesIn('31/02/2026 and 2026')).toEqual([]);
  });

  it('reads CSV rows of any width', () => {
    expect(csvRows('a\n"b,1",2\r\n')).toEqual([['a'], ['b,1', '2']]);
  });
});
