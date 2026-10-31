// The rules of @platform/eslint-plugin. Each enforces something the design doc already requires of the
// shell and remotes; the rule's doc string names the section.
import type { Rule } from 'eslint';
import type * as ESTree from 'estree';
import { FORBIDDEN_REQUEST_HEADERS } from './generated/forbidden-headers.ts';
import { SDK_PACKAGE, SDK_SUBPATHS } from './generated/sdk.ts';

type Node = ESTree.Node & { parent?: Node };

const DOCS = 'docs/design/frontend-sdk-design.md';

function rule(description: string, messages: Record<string, string>, create: Rule.RuleModule['create'], schema: Rule.RuleMetaData['schema'] = []): Rule.RuleModule {
  return { meta: { type: 'problem', docs: { description, url: DOCS }, messages, schema }, create };
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
    const report = (node: Node, name: string) => context.report({ node, messageId: 'header', data: { name } });
    const checkObject = (obj: Node) => {
      if (obj.type !== 'ObjectExpression') return;
      for (const p of obj.properties) {
        if (p.type !== 'Property') continue;
        const name = keyName(p);
        if (name && FORBIDDEN.has(name.toLowerCase())) report(p.key as Node, name);
      }
    };
    return {
      // { headers: { 'x-user-id': … } } in fetch(), ApiClient options, …
      Property(n) {
        if (keyName(n) === 'headers') checkObject(n.value as Node);
      },
      NewExpression(n) {
        if (n.callee.type === 'Identifier' && n.callee.name === 'Headers' && n.arguments[0]) checkObject(n.arguments[0] as Node);
      },
      // headers.set('x-tenant-id', …) / append(…)
      CallExpression(n) {
        if (n.callee.type !== 'MemberExpression') return;
        const m = memberName(n.callee);
        const first = n.arguments[0];
        if ((m === 'set' || m === 'append') && first?.type === 'Literal' && typeof first.value === 'string' && FORBIDDEN.has(first.value.toLowerCase())) {
          report(first as Node, first.value);
        }
      },
    };
  },
);

const STORAGES = new Set(['localStorage', 'sessionStorage']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

export const noRawStorage = rule(
  "Use storage(appId) from '@platform/frontend-sdk/storage', which namespaces keys by workspace and refuses token-like keys (§C1 /storage).",
  { raw: "Use storage(appId) from '@platform/frontend-sdk/storage' instead of {{name}}: keys must be namespaced per workspace, and tokens never stored." },
  (context) => ({
    'Program:exit'(program: ESTree.Program) {
      const scope = context.sourceCode.getScope(program);
      for (const ref of scope.through) {
        if (STORAGES.has(ref.identifier.name)) context.report({ node: ref.identifier, messageId: 'raw', data: { name: ref.identifier.name } });
      }
    },
    MemberExpression(n) {
      const name = memberName(n);
      if (name && STORAGES.has(name) && n.object.type === 'Identifier' && GLOBAL_OBJECTS.has(n.object.name)) {
        context.report({ node: n, messageId: 'raw', data: { name: `${n.object.name}.${name}` } });
      }
    },
  }),
);

const HTML_PROPS = new Set(['innerHTML', 'outerHTML']);

export const noUnsafeHtml = rule(
  "HTML goes through sanitizeHtml from '@platform/frontend-sdk/security' (DOMPurify + Trusted Types, §C1 /security, §C3 CSP).",
  {
    unsanitized: "{{what}} needs sanitizeHtml(...) from '@platform/frontend-sdk/security' (Trusted Types are enforced).",
    write: '{{what}} is never allowed: it writes unsanitized HTML.',
  },
  (context) => {
    const sanitizers = new Set<string>((context.options[0] as { sanitizers?: string[] } | undefined)?.sanitizers ?? ['sanitizeHtml']);
    const isSanitized = (n: Node | null | undefined): boolean => {
      if (!n || n.type !== 'CallExpression') return false;
      const c = n.callee;
      const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' ? memberName(c) : undefined;
      return name !== undefined && sanitizers.has(name);
    };
    return {
      AssignmentExpression(n) {
        if (n.left.type !== 'MemberExpression') return;
        const name = memberName(n.left);
        if (name && HTML_PROPS.has(name) && !isSanitized(n.right as Node)) context.report({ node: n, messageId: 'unsanitized', data: { what: name } });
      },
      CallExpression(n) {
        if (n.callee.type !== 'MemberExpression') return;
        const name = memberName(n.callee);
        if (name === 'insertAdjacentHTML' && !isSanitized(n.arguments[1] as Node)) context.report({ node: n, messageId: 'unsanitized', data: { what: name } });
        if ((name === 'write' || name === 'writeln') && n.callee.object.type === 'Identifier' && n.callee.object.name === 'document') {
          context.report({ node: n, messageId: 'write', data: { what: `document.${name}` } });
        }
      },
      // JSX: dangerouslySetInnerHTML={{ __html: sanitizeHtml(x) }}
      JSXAttribute(node: Node) {
        const n = node as unknown as { name: { name?: unknown }; value?: { type: string; expression?: Node } | null };
        if (n.name.name !== 'dangerouslySetInnerHTML') return;
        const expr = n.value?.type === 'JSXExpressionContainer' ? n.value.expression : undefined;
        const html =
          expr?.type === 'ObjectExpression'
            ? expr.properties.find((p): p is ESTree.Property => p.type === 'Property' && propertyName(p.key as Node) === '__html')?.value
            : undefined;
        if (!isSanitized(html as Node | undefined)) context.report({ node, messageId: 'unsanitized', data: { what: 'dangerouslySetInnerHTML' } });
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
