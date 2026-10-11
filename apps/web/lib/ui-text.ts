import ts from 'typescript';

// The words a screen shows, read from its source (ADR 129): the text between tags, and the
// strings a person reads (labels, titles, placeholders, messages, the strings inside {...}).
// Not class names, links, test ids or other strings only the code reads.

const NOT_TEXT = new Set([
  'className',
  'href',
  'src',
  'key',
  'id',
  'type',
  'name',
  'role',
  'inputMode',
  'autoComplete',
  'data-testid',
  'method',
  'action',
  'accept',
  'capture',
  'icon',
  'pattern',
  'rel',
  'target',
  'form',
  'htmlFor',
  'variant',
  'tone',
  'size',
  'kind',
  'mode',
  'sizes',
  'enterKeyHint',
  'fill',
  'stroke',
  'viewBox',
  'd',
  'xmlns',
  'strokeLinecap',
  'strokeLinejoin',
  'colour',
  'color',
]);

const TEXT_CALLS = new Set(['setError', 'setStatus', 'setMessage', 'setNote', 'fail', 'confirm']);
const TEXT_PROPS = new Set(['message', 'label', 'title', 'hint', 'word', 'words', 'text', 'help']);

/** A string a person reads, not a code, a path, a class list or a format. */
export function looksLikeWords(s: string): boolean {
  const t = s.trim();
  if (!/[A-Za-z]{2}/.test(t)) return false;
  if (/^[a-z0-9_.:/#?=&-]+$/.test(t)) return false; // codes, paths, keys
  if (/^[A-Z0-9_]+$/.test(t)) return false; // CODES
  if (/\b(?:bg|text|ring|flex|grid|rounded|min-h|px|py|gap|w|h)-/.test(t)) return false; // classes
  if (/^(?:\/|https?:)/.test(t)) return false;
  return true;
}

function attrName(n: ts.Node): string | null {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isJsxAttribute(p)) return p.name.getText();
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return null;
  }
  return null;
}

function inJsx(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isJsxExpression(p) || ts.isJsxAttribute(p)) return true;
    if (ts.isFunctionLike(p) && !ts.isArrowFunction(p)) return false;
  }
  return false;
}

function readByPerson(
  n: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
): boolean {
  const attr = attrName(n);
  if (attr !== null) return !NOT_TEXT.has(attr);
  const p = n.parent;
  if (ts.isCallExpression(p) && TEXT_CALLS.has(p.expression.getText().split('.').pop() ?? '')) {
    return true;
  }
  if (ts.isPropertyAssignment(p) && TEXT_PROPS.has(p.name.getText())) return true;
  return inJsx(n);
}

/** The lines of text a .tsx file shows. */
export function uiText(source: string, fileName = 'x.tsx'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const t = n.getText().replace(/\s+/g, ' ').trim();
      if (t && looksLikeWords(t)) out.push(t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (looksLikeWords(n.text) && readByPerson(n)) out.push(n.text.trim());
    } else if (ts.isTemplateExpression(n)) {
      // `${n} items waiting`: the words around the values
      const t = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' ').trim();
      if (looksLikeWords(t) && readByPerson(n)) out.push(t.replace(/\s+/g, ' '));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
