// ICU-lite message formatting (design doc §C1 /i18n): a small parser and renderer for the ICU
// MessageFormat subset translators need, with no eval or Function. Supported:
//   {name}                                   the value as text (numbers formatted for the locale)
//   {n, number}                              a locale-formatted number
//   {n, plural, =0 {…} one {…} other {…}}    Intl.PluralRules categories, exact =N matches, # inside
//   {n, plural, offset:1 …}                  ICU offset (# shows n - offset)
//   {g, select, female {…} other {…}}        a choice on a string value
//   'quoted' text                            ICU apostrophe quoting; '' is a literal apostrophe
// A malformed message renders as its raw text; a missing value leaves its {placeholder} visible.

export type MessageVars = Readonly<Record<string, string | number>>;

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'var'; name: string; format?: 'number' }
  | { kind: 'pound' }
  | { kind: 'plural'; name: string; offset: number; options: Map<string, Node[]> }
  | { kind: 'select'; name: string; options: Map<string, Node[]> };

class ParseError extends Error {}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Parses `src` into nodes; `inPlural` makes '#' special. Throws ParseError on malformed input. */
export function parseMessage(src: string): Node[] {
  let i = 0;

  const parseNodes = (inPlural: boolean, nested: boolean): Node[] => {
    const nodes: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) nodes.push({ kind: 'text', value: text });
      text = '';
    };
    while (i < src.length) {
      const c = src[i]!;
      if (c === "'") {
        // '' is a literal apostrophe; '{…}' (or '#…' in a plural) is quoted literal text.
        if (src[i + 1] === "'") {
          text += "'";
          i += 2;
          continue;
        }
        const next = src[i + 1];
        if (next === '{' || next === '}' || (inPlural && next === '#')) {
          const end = src.indexOf("'", i + 1);
          if (end < 0) {
            text += src.slice(i + 1);
            i = src.length;
          } else {
            text += src.slice(i + 1, end).replace(/''/g, "'");
            i = end + 1;
          }
          continue;
        }
        text += c;
        i++;
        continue;
      }
      if (c === '{') {
        flush();
        nodes.push(parseArgument(inPlural));
        continue;
      }
      if (c === '}') {
        if (!nested) throw new ParseError(`unexpected } at ${i}`);
        flush();
        return nodes;
      }
      if (c === '#' && inPlural) {
        flush();
        nodes.push({ kind: 'pound' });
        i++;
        continue;
      }
      text += c;
      i++;
    }
    if (nested) throw new ParseError('unterminated option');
    flush();
    return nodes;
  };

  const skipSpace = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };

  const readUntil = (stops: string): string => {
    const start = i;
    while (i < src.length && !stops.includes(src[i]!)) i++;
    return src.slice(start, i).trim();
  };

  const parseOptions = (inPlural: boolean): { offset: number; options: Map<string, Node[]> } => {
    const options = new Map<string, Node[]>();
    let offset = 0;
    for (;;) {
      skipSpace();
      if (src[i] === '}') {
        i++;
        break;
      }
      const selector = readUntil('{} \t\n\r');
      if (selector === '') throw new ParseError(`missing selector at ${i}`);
      if (selector.startsWith('offset:') && inPlural) {
        offset = Number(selector.slice('offset:'.length));
        if (!Number.isInteger(offset) || offset < 0) throw new ParseError('bad offset');
        continue;
      }
      skipSpace();
      if (src[i] !== '{') throw new ParseError(`expected { after ${selector}`);
      i++;
      options.set(selector, parseNodes(inPlural, true));
      i++; // the closing }
    }
    if (!options.has('other')) throw new ParseError('an "other" option is required');
    return { offset, options };
  };

  const parseArgument = (inPlural: boolean): Node => {
    i++; // {
    const name = readUntil(',}');
    if (!NAME.test(name)) throw new ParseError(`bad argument name ${JSON.stringify(name)}`);
    if (src[i] === '}') {
      i++;
      return { kind: 'var', name };
    }
    i++; // ,
    const type = readUntil(',}');
    if (type === 'number' && src[i] === '}') {
      i++;
      return { kind: 'var', name, format: 'number' };
    }
    if (src[i] !== ',') throw new ParseError(`unsupported argument type ${JSON.stringify(type)}`);
    i++; // ,
    if (type === 'plural') {
      const { offset, options } = parseOptions(true);
      return { kind: 'plural', name, offset, options };
    }
    if (type === 'select') return { kind: 'select', name, options: parseOptions(inPlural).options };
    throw new ParseError(`unsupported argument type ${JSON.stringify(type)}`);
  };

  return parseNodes(false, false);
}

const cache = new Map<string, Node[] | null>();
const CACHE_LIMIT = 2000;

function parsed(src: string): Node[] | null {
  let nodes = cache.get(src);
  if (nodes === undefined) {
    try {
      nodes = parseMessage(src);
    } catch {
      nodes = null;
    }
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(src, nodes);
  }
  return nodes;
}

export interface FormatContext {
  locale: string;
  number: (n: number) => string;
  plural: (n: number) => Intl.LDMLPluralRule;
}

/** A value the caller passed, never one inherited from Object.prototype ({constructor}, {toString}). */
function own(vars: MessageVars, name: string): string | number | undefined {
  return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
}

function render(nodes: readonly Node[], vars: MessageVars, ctx: FormatContext, pound: number | undefined): string {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.value;
        break;
      case 'pound':
        out += pound === undefined ? '#' : ctx.number(pound);
        break;
      case 'var': {
        const v = own(vars, n.name);
        if (v === undefined) out += `{${n.name}}`;
        else out += typeof v === 'number' ? ctx.number(v) : String(v);
        break;
      }
      case 'plural': {
        const raw = own(vars, n.name);
        const v = typeof raw === 'number' ? raw : Number(raw);
        if (raw === undefined || Number.isNaN(v)) {
          out += `{${n.name}}`;
          break;
        }
        const exact = n.options.get(`=${v}`);
        const branch = exact ?? n.options.get(ctx.plural(v - n.offset)) ?? n.options.get('other')!;
        out += render(branch, vars, ctx, v - n.offset);
        break;
      }
      case 'select': {
        const v = own(vars, n.name);
        const branch = (v !== undefined && n.options.get(String(v))) || n.options.get('other')!;
        out += render(branch, vars, ctx, pound);
        break;
      }
    }
  }
  return out;
}

/** Formats an ICU-lite message. A malformed message is returned as is (and reported by `onError`). */
export function formatMessage(src: string, vars: MessageVars | undefined, ctx: FormatContext, onError?: (src: string) => void): string {
  const nodes = parsed(src);
  if (!nodes) {
    onError?.(src);
    return src;
  }
  return render(nodes, vars ?? {}, ctx, undefined);
}
