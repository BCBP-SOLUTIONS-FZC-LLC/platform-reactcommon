// The rules of @bcbp-solutions-fzc-llc/eslint-plugin. Each enforces something the design doc already requires of the
// shell and remotes; the rule's doc string names the section.
import type { Rule, Scope } from 'eslint';
import type * as ESTree from 'estree';
import { FORBIDDEN_REQUEST_HEADERS } from './generated/forbidden-headers.ts';
import { SDK_PACKAGE, SDK_SUBPATHS } from './generated/sdk.ts';

type Node = ESTree.Node & { parent?: Node };

/** The rules' reference: the LLD's table of what each rule reports (an absolute URL: editors open it as is). */
export const DOCS_URL = 'https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/docs/lld/platform-reactcommon-lld.md#132-bcbp-solutions-fzc-llceslint-plugin';

function rule(description: string, messages: Record<string, string>, create: Rule.RuleModule['create'], schema: Rule.RuleMetaData['schema'] = []): Rule.RuleModule {
  return { meta: { type: 'problem', docs: { description, url: DOCS_URL }, messages, schema }, create };
}

/** The variable `name` refers to at `node`, or undefined for a global no declaration binds. */
function findVariable(context: Rule.RuleContext, node: Node, name: string): Scope.Variable | undefined {
  for (let scope: Scope.Scope | null = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const v = scope.set.get(name);
    if (v && v.defs.length > 0) return v;
  }
  return undefined;
}

const TS_WRAPPERS = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion']);
/** `node` without TypeScript's type-only wrappers (`x as T`, `x!`, `x satisfies T`, `<T>x`). */
function unwrap(node: Node | null | undefined): Node | null | undefined {
  let n = node;
  while (n && TS_WRAPPERS.has(n.type as string)) n = (n as unknown as { expression: Node }).expression;
  return n;
}

/** The value of a string literal or of a template literal without expressions (`…`), else undefined. */
function staticString(n: Node | null | undefined): string | undefined {
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/** Calls `check(source, node)` for every static module specifier: import, export … from, import(), require(). */
function moduleSources(check: (source: string, node: Node) => void): Rule.RuleListener {
  const visit = (source: Node | null | undefined) => {
    const value = staticString(source);
    if (value !== undefined) check(value, source!);
  };
  return {
    ImportDeclaration: (n) => visit(n.source as Node),
    ExportNamedDeclaration: (n) => visit(n.source as Node | null),
    ExportAllDeclaration: (n) => visit(n.source as Node),
    ImportExpression: (n) => visit(n.source as Node),
    CallExpression: (n) => {
      if (n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments.length === 1) visit(n.arguments[0] as Node);
    },
  };
}

function propertyName(n: Node): string | undefined {
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  return undefined;
}

/** An object property's key: `a`, 'a', ['a'] or [`a`]; undefined for a computed expression. */
function keyName(p: ESTree.Property): string | undefined {
  return p.computed ? staticString(p.key as Node) : propertyName(p.key as Node);
}

function memberName(n: ESTree.MemberExpression): string | undefined {
  if (!n.computed) return propertyName(n.property as Node);
  return n.property.type === 'Literal' && typeof n.property.value === 'string' ? n.property.value : undefined;
}

// --- imports (§C1 "Build": no root barrel; index.ts is the only public surface) ------------------

export const noSdkRootImport = rule(
  `Import a subpath of ${SDK_PACKAGE} (e.g. '${SDK_PACKAGE}/http'); the package root has no exports (§C1).`,
  { root: `'${SDK_PACKAGE}' has no exports: import a subpath such as '${SDK_PACKAGE}/http'.` },
  (context) => moduleSources((source, node) => source === SDK_PACKAGE && context.report({ node, messageId: 'root' })),
);

export const noSdkDeepImport = rule(
  `Import ${SDK_PACKAGE} only through its public subpaths, never its files (§C1).`,
  { deep: `'{{source}}' is not a public entry point of ${SDK_PACKAGE}; use one of: {{subpaths}}.` },
  (context) =>
    moduleSources((source, node) => {
      if (!source.startsWith(`${SDK_PACKAGE}/`)) return;
      const rest = source.slice(SDK_PACKAGE.length + 1);
      if ((SDK_SUBPATHS as readonly string[]).includes(rest) || rest === 'package.json') return;
      context.report({ node, messageId: 'deep', data: { source, subpaths: SDK_SUBPATHS.map((s) => `${SDK_PACKAGE}/${s}`).join(', ') } });
    }),
);

// --- security (§C1 /http, /storage, /security) -------------------------------------------------

const FORBIDDEN = new Set<string>(FORBIDDEN_REQUEST_HEADERS);

export const noIdentityHeaders = rule(
  'The browser never sends identity headers: the gateway derives them from the token and strips any it receives (§C1 /http).',
  { header: "'{{name}}' is an identity header the gateway sets from the token; the browser must never send it." },
  (context) => {
    const report = (node: ESTree.Node, name: string) => context.report({ node, messageId: 'header', data: { name } });
    /** Reports `node` if it is a static string naming a forbidden header. */
    const checkName = (node: Node | null | undefined) => {
      const name = staticString(node);
      if (name !== undefined && FORBIDDEN.has(name.toLowerCase())) report(node!, name);
    };
    /** A HeadersInit literal: { 'x-user-id': … } or [['x-user-id', …], …]. */
    const checkInit = (init: Node | null | undefined) => {
      const n = unwrap(init);
      if (n?.type === 'ObjectExpression') {
        for (const p of n.properties) {
          if (p.type !== 'Property') continue;
          const name = keyName(p);
          if (name && FORBIDDEN.has(name.toLowerCase())) report(p.key as Node, name);
        }
      } else if (n?.type === 'ArrayExpression') {
        for (const pair of n.elements) {
          const p = unwrap(pair as Node | null);
          if (p?.type === 'ArrayExpression') checkName(p.elements[0] as Node | null);
        }
      }
    };
    return {
      // { headers: { 'x-user-id': … } } in fetch(), ApiClient options, …
      Property(n) {
        if (keyName(n) === 'headers') checkInit(n.value as Node);
      },
      // new Headers({ … }) / new Headers([[…]]), also globalThis.Headers / window.Headers
      NewExpression(n) {
        const c = n.callee;
        const isHeaders = (c.type === 'Identifier' && c.name === 'Headers') || (c.type === 'MemberExpression' && memberName(c) === 'Headers');
        if (isHeaders) checkInit(n.arguments[0] as Node | undefined);
      },
      AssignmentExpression(n) {
        if (n.left.type !== 'MemberExpression') return;
        // h['x-user-id'] = v
        if (n.left.computed) checkName(n.left.property as Node);
        // init.headers = { 'x-user-id': … }
        if (memberName(n.left) === 'headers') checkInit(n.right as Node);
      },
      // headers.set('x-tenant-id', …) / append(…), with a string or a template without expressions
      CallExpression(n) {
        if (n.callee.type !== 'MemberExpression') return;
        const m = memberName(n.callee);
        if (m === 'set' || m === 'append') checkName(n.arguments[0] as Node | undefined);
      },
    };
  },
);

const STORAGES = new Set(['localStorage', 'sessionStorage']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

export const noRawStorage = rule(
  "Use storage(appId) from '@bcbp-solutions-fzc-llc/frontend-sdk/storage', which namespaces keys by workspace and refuses token-like keys (§C1 /storage).",
  { raw: "Use storage(appId) from '@bcbp-solutions-fzc-llc/frontend-sdk/storage' instead of {{name}}: keys must be namespaced per workspace, and tokens never stored." },
  (context) => {
    /**
     * The global object's name if `node` is the global object: `window`, `globalThis`, `self`, a chain of
     * them (`window.self`), or a variable initialised once with one (`const w = window`).
     */
    const globalObject = (node: Node | null | undefined, depth = 0): string | undefined => {
      const n = unwrap(node);
      if (!n || depth > 8) return undefined;
      if (n.type === 'MemberExpression') {
        const name = memberName(n);
        return name && GLOBAL_OBJECTS.has(name) && globalObject(n.object as Node, depth + 1) ? name : undefined;
      }
      if (n.type !== 'Identifier') return undefined;
      const v = findVariable(context, n, n.name);
      if (!v) return GLOBAL_OBJECTS.has(n.name) ? n.name : undefined;
      // An alias: one declarator with an initialiser, and no later assignment.
      const def = v.defs[0]!;
      if (v.defs.length !== 1 || def.type !== 'Variable' || def.node.id.type !== 'Identifier') return undefined;
      if (v.references.some((r) => r.isWrite() && r.identifier !== def.node.id)) return undefined;
      return globalObject(def.node.init as Node | null, depth + 1) ? n.name : undefined;
    };
    const report = (node: ESTree.Node, name: string) => context.report({ node, messageId: 'raw', data: { name } });
    return {
      'Program:exit'(program: ESTree.Program) {
        const scope = context.sourceCode.getScope(program);
        for (const ref of scope.through) {
          if (STORAGES.has(ref.identifier.name)) report(ref.identifier as Node, ref.identifier.name);
        }
        // A configured global (languageOptions.globals: globals.browser, as nearly every browser project
        // sets) is resolved, so its references are not in `through`: a declared-nowhere variable's are.
        for (const name of STORAGES) {
          const v = scope.set.get(name);
          if (v && v.defs.length === 0) for (const ref of v.references) report(ref.identifier as Node, name);
        }
      },
      // window.localStorage, globalThis['sessionStorage'], w.localStorage after const w = window
      MemberExpression(n) {
        const name = memberName(n);
        if (!name || !STORAGES.has(name)) return;
        const object = globalObject(n.object as Node);
        if (object) report(n, `${object}.${name}`);
      },
      // const { localStorage } = window
      VariableDeclarator(n) {
        if (n.id.type !== 'ObjectPattern' || !globalObject(n.init as Node | null)) return;
        for (const p of n.id.properties) {
          const name = p.type === 'Property' ? keyName(p) : undefined;
          if (name && STORAGES.has(name)) report(p as Node, name);
        }
      },
    };
  },
);

/** Element properties whose assignment parses HTML. */
const HTML_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
/** Methods that parse their argument at `index` as HTML. */
const HTML_METHODS = new Map([
  ['insertAdjacentHTML', 1],
  ['setHTMLUnsafe', 0],
  ['parseHTMLUnsafe', 0],
  ['createContextualFragment', 0],
]);
const SECURITY = `${SDK_PACKAGE}/security`;

export const noUnsafeHtml = rule(
  `HTML goes through sanitizeHtml from '${SECURITY}' (DOMPurify + Trusted Types, §C1 /security, §C3 CSP).`,
  {
    unsanitized: `{{what}} needs sanitizeHtml(...) imported from '${SECURITY}' (Trusted Types are enforced).`,
    write: '{{what}} is never allowed: it writes unsanitized HTML.',
  },
  (context) => {
    const custom = (context.options[0] as { sanitizers?: string[] } | undefined)?.sanitizers;
    const sanitizers = new Set<string>(custom ?? []);
    /** Whether `id` (a callee, or a member's object) is bound by an import of the SDK's /security: `imported` names the import. */
    const importedFromSecurity = (id: ESTree.Identifier, imported: 'sanitizeHtml' | '*'): boolean => {
      const def = findVariable(context, id as Node, id.name)?.defs[0];
      if (def?.type !== 'ImportBinding') return false;
      const decl = def.parent as ESTree.ImportDeclaration;
      if (decl.source.value !== SECURITY) return false;
      const spec = def.node;
      if (imported === '*') return spec.type === 'ImportNamespaceSpecifier';
      return spec.type === 'ImportSpecifier' && (spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value) === 'sanitizeHtml';
    };
    const isSanitized = (node: Node | null | undefined): boolean => {
      const n = unwrap(node);
      if (!n || n.type !== 'CallExpression') return false;
      const c = n.callee;
      // A sanitizer named in the options is trusted by its name.
      if (custom) {
        const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' ? memberName(c) : undefined;
        return name !== undefined && sanitizers.has(name);
      }
      // By default only the SDK's: sanitizeHtml(…) (or an alias) imported from /security, or security.sanitizeHtml(…) of its namespace.
      if (c.type === 'Identifier') return importedFromSecurity(c, 'sanitizeHtml');
      return c.type === 'MemberExpression' && memberName(c) === 'sanitizeHtml' && c.object.type === 'Identifier' && importedFromSecurity(c.object, '*');
    };
    const report = (node: ESTree.Node, what: string) => context.report({ node, messageId: 'unsanitized', data: { what } });
    return {
      // el.innerHTML = …, el.outerHTML = …, iframe.srcdoc = …
      AssignmentExpression(n) {
        if (n.left.type !== 'MemberExpression') return;
        const name = memberName(n.left);
        if (name && HTML_PROPS.has(name) && !isSanitized(n.right as Node)) report(n, name);
      },
      CallExpression(n) {
        if (n.callee.type !== 'MemberExpression') return;
        const name = memberName(n.callee);
        if (!name) return;
        const index = HTML_METHODS.get(name);
        if (index !== undefined && !isSanitized(n.arguments[index] as Node | undefined)) report(n, name);
        // new DOMParser().parseFromString(text, type), of any type: XML-parsed XHTML and SVG elements keep their
        // event-handler attributes when adopted, and under require-trusted-types-for 'script' every type needs
        // TrustedHTML, so an unsanitized string throws in production.
        if (name === 'parseFromString' && n.arguments.length >= 2 && !isSanitized(n.arguments[0] as Node)) report(n, 'DOMParser.parseFromString');
        // el.setAttribute('srcdoc', html)
        if (name === 'setAttribute' && staticString(n.arguments[0] as Node)?.toLowerCase() === 'srcdoc' && !isSanitized(n.arguments[1] as Node)) report(n, 'srcdoc');
        if ((name === 'write' || name === 'writeln') && n.callee.object.type === 'Identifier' && n.callee.object.name === 'document') {
          context.report({ node: n, messageId: 'write', data: { what: `document.${name}` } });
        }
      },
      // JSX: dangerouslySetInnerHTML={{ __html: sanitizeHtml(x) }}, <iframe srcDoc={sanitizeHtml(x)} />
      JSXAttribute(node: Node) {
        const n = node as unknown as { name: { name?: unknown }; value?: { type: string; expression?: Node } | null };
        const expr = n.value?.type === 'JSXExpressionContainer' ? n.value.expression : undefined;
        if (n.name.name === 'srcDoc') {
          if (!isSanitized(expr)) report(node, 'srcDoc');
          return;
        }
        if (n.name.name !== 'dangerouslySetInnerHTML') return;
        const object = unwrap(expr);
        const html =
          object?.type === 'ObjectExpression'
            ? object.properties.find((p): p is ESTree.Property => p.type === 'Property' && propertyName(p.key as Node) === '__html')?.value
            : undefined;
        if (!isSanitized(html as Node | undefined)) report(node, 'dangerouslySetInnerHTML');
      },
    } as Rule.RuleListener;
  },
  [{ type: 'object', properties: { sanitizers: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
);

// --- CSP / styling (§C3, §D3) -------------------------------------------------------------------

const CSS_IN_JS = [/^@emotion\//, /^styled-components(\/|$)/, /^@mui\//, /^@stitches\/react$/, /^goober(\/|$)/, /^styled-jsx(\/|$)/, /^@vanilla-extract\/dynamic$/];

export const noRuntimeCssInJs = rule(
  "Runtime CSS-in-JS needs style-src 'unsafe-inline'; use zero-runtime CSS (CSS Modules, vanilla-extract, Linaria). Exceptions only in writing (§C3, §D3).",
  { css: "'{{source}}' injects styles at runtime, which style-src 'self' blocks. Use zero-runtime CSS, or list a written exception in `allow`." },
  (context) => {
    const allow = new Set<string>((context.options[0] as { allow?: string[] } | undefined)?.allow ?? []);
    return moduleSources((source, node) => {
      if (!allow.has(source) && CSS_IN_JS.some((p) => p.test(source))) context.report({ node, messageId: 'css', data: { source } });
    });
  },
  [{ type: 'object', properties: { allow: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
);

// --- route templates (§C1 /http, §C4) -----------------------------------------------------------

const API_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function leftmostString(n: Node): string | undefined {
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis[0]?.value.cooked ?? undefined;
  if (n.type === 'BinaryExpression' && n.operator === '+') return leftmostString(n.left as Node);
  return undefined;
}

export const apiRouteTemplate = rule(
  "ApiClient paths are route templates ('/tenders/:id' + params), so a raw URL never becomes a metric label (§C1 /http, §C4).",
  { template: "Pass a route template such as '/tenders/:id' with { params }, not a built URL: the template is the metric's route label." },
  (context) => ({
    CallExpression(n) {
      if (n.callee.type !== 'MemberExpression') return;
      const m = memberName(n.callee);
      const first = n.arguments[0] as Node | undefined;
      if (!m || !API_METHODS.has(m) || !first) return;
      const built = (first.type === 'TemplateLiteral' && first.expressions.length > 0) || (first.type === 'BinaryExpression' && first.operator === '+');
      // Only path-like strings: Map#get(`${a}:${b}`) and friends are not API calls.
      if (built && leftmostString(first)?.startsWith('/')) context.report({ node: first, messageId: 'template' });
    },
  }),
);
