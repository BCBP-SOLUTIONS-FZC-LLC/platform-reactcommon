// sanitizeHtml's pre-pass (security/index.ts): internal, not part of the /security API.
//
// A single forward scan, linear in the input: it runs on untrusted HTML, so no backtracking regex (an
// earlier regex version took 12 s on 100 KB of unclosed tags).

const isSpaceOrSlash = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === '/';
const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const REPORTED_ATTR = /^(?:on|style$)/i;

/**
 * The input without what DOMPurify would remove anyway and Chromium reports while merely parsing it:
 * event-handler and style attributes, and <style> elements. Chromium's parser applies the page CSP to
 * the detached document DOMPurify parses into (every way of creating one inherits it), so each such
 * attribute in hostile input was reported (script-src-attr / style-src-attr, POSTed to /csp-report)
 * though nothing ran. Not a security boundary: DOMPurify still sanitises the result; a form this scan
 * reads differently from a browser costs at most a report.
 */
export function withoutReportedMarkup(input: string): string {
  const n = input.length;
  const lower = input.toLowerCase();
  let out = '';
  let i = 0;
  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt < 0 || lt + 1 >= n || !isLetter(input[lt + 1]!)) {
      // No tag here: copy up to and including this '<' (or the rest) and go on.
      const end = lt < 0 ? n : lt + 1;
      out += input.slice(i, end);
      i = end;
      continue;
    }
    out += input.slice(i, lt);
    // The tag name.
    let j = lt + 1;
    while (j < n && !isSpaceOrSlash(input[j]!) && input[j] !== '>') j++;
    const name = lower.slice(lt + 1, j);
    let tag = input.slice(lt, j);
    // Its attributes, each kept or dropped whole.
    let closed = false;
    while (j < n) {
      const sepStart = j;
      while (j < n && isSpaceOrSlash(input[j]!)) j++;
      if (j >= n) break;
      if (input[j] === '>') {
        tag += input.slice(sepStart, j + 1);
        j++;
        closed = true;
        break;
      }
      const attrStart = j;
      while (j < n && !isSpaceOrSlash(input[j]!) && input[j] !== '>' && input[j] !== '=') j++;
      const attr = input.slice(attrStart, j);
      let k = j;
      while (k < n && (input[k] === ' ' || input[k] === '\n' || input[k] === '\t' || input[k] === '\r' || input[k] === '\f')) k++;
      if (k < n && input[k] === '=') {
        k++;
        while (k < n && (input[k] === ' ' || input[k] === '\n' || input[k] === '\t' || input[k] === '\r' || input[k] === '\f')) k++;
        const q = input[k];
        if (q === '"' || q === "'") {
          const close = input.indexOf(q, k + 1);
          if (close < 0) {
            k = n; // an unterminated value runs to the end, as in the browser
          } else k = close + 1;
        } else {
          while (k < n && !(input[k] === ' ' || input[k] === '\n' || input[k] === '\t' || input[k] === '\r' || input[k] === '\f' || input[k] === '>')) k++;
        }
        j = k;
      }
      if (!REPORTED_ATTR.test(attr)) tag += input.slice(sepStart, j);
    }
    if (!closed) {
      // An unterminated tag: the browser drops it at the end of input; keep the text as it was.
      out += input.slice(lt, n);
      break;
    }
    if (name === 'style') {
      // A <style> element: drop it with its content up to </style (case-insensitive), linear.
      const end = lower.indexOf('</style', j);
      if (end < 0) {
        out += input.slice(lt, n); // unterminated: the sanitizer removes it; leave the text untouched
        break;
      }
      const gt = input.indexOf('>', end);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    out += tag;
    i = j;
  }
  return out;
}
