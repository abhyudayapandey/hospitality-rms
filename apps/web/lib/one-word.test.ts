import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// One word, Request (ADR 144): what people ask for is a Request, from a store or to buy; the
// Main Store's buying is an Order. The old names never come back on a screen, a button or a
// label: code comments may still say what a thing was.

const WEB = join(import.meta.dirname, '..');
const OLD =
  /\b(stock requests?|supply requests?|request for material|ask for (stock|supplies|these|more))\b/i;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? files(join(dir, d.name))
      : /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name)
        ? [join(dir, d.name)]
        : [],
  );
}

/** A file's lines that are code, not comments. */
function codeLines(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .filter((l) => !/^\s*\{?\s*\/\*/.test(l));
}

const found = ['app', 'components', 'lib'].flatMap((d) =>
  files(join(WEB, d)).flatMap((f) =>
    codeLines(readFileSync(f, 'utf8'))
      .filter((l) => OLD.test(l))
      .map((l) => `${f.slice(WEB.length + 1)}: ${l.trim()}`),
  ),
);

describe('one word for what people ask for', () => {
  it('no screen says Stock request, Supply request or Ask for stock', () => {
    expect(found).toEqual([]);
  });
});
