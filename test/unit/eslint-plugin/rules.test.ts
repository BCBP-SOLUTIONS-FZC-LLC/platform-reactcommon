import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import plugin, { rules } from '../../../packages/eslint-plugin/src/index.ts';
import { DOCS_URL } from '../../../packages/eslint-plugin/src/rules.ts';
import { FORBIDDEN_REQUEST_HEADERS } from '../../../packages/frontend-sdk/src/internal/generated/forbidden-headers.ts';
import { FORBIDDEN_REQUEST_HEADERS as PLUGIN_FORBIDDEN } from '../../../packages/eslint-plugin/src/generated/forbidden-headers.ts';

RuleTester.describe = describe;
const SANITIZE = "import { sanitizeHtml } from '@bcbp-solutions-fzc-llc/frontend-sdk/security';";
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } }, ecmaVersion: 'latest', sourceType: 'module' },
});

tester.run('no-sdk-root-import', rules['no-sdk-root-import']!, {
  valid: [
    "import { getLogger } from '@bcbp-solutions-fzc-llc/frontend-sdk/logging';",
    "import x from '@bcbp-solutions-fzc-llc/frontend-sdk-extra';",
    'const m = require(`@bcbp-solutions-fzc-llc/frontend-sdk${suffix}`);', // a built specifier is not static: not checked
  ],
  invalid: [
    { code: "import { getLogger } from '@bcbp-solutions-fzc-llc/frontend-sdk';", errors: [{ messageId: 'root' }] },
    { code: "export * from '@bcbp-solutions-fzc-llc/frontend-sdk';", errors: [{ messageId: 'root' }] },
    { code: "const m = await import('@bcbp-solutions-fzc-llc/frontend-sdk');", errors: [{ messageId: 'root' }] },
    { code: "const m = require('@bcbp-solutions-fzc-llc/frontend-sdk');", errors: [{ messageId: 'root' }] },
    { code: 'const m = require(`@bcbp-solutions-fzc-llc/frontend-sdk`);', errors: [{ messageId: 'root' }] },
    { code: 'const m = await import(`@bcbp-solutions-fzc-llc/frontend-sdk`);', errors: [{ messageId: 'root' }] },
  ],
});

tester.run('no-sdk-deep-import', rules['no-sdk-deep-import']!, {
  valid: [
    "import { createApiClient } from '@bcbp-solutions-fzc-llc/frontend-sdk/http';",
    "import { createTestPlatform } from '@bcbp-solutions-fzc-llc/frontend-sdk/testing';",
    "import pkg from '@bcbp-solutions-fzc-llc/frontend-sdk/package.json';",
    'const m = await import(`@bcbp-solutions-fzc-llc/frontend-sdk/${name}`);', // a built specifier is not static: not checked
  ],
  invalid: [
    { code: "import { x } from '@bcbp-solutions-fzc-llc/frontend-sdk/http/client';", errors: [{ messageId: 'deep' }] },
    { code: "import { x } from '@bcbp-solutions-fzc-llc/frontend-sdk/dist/http/index.js';", errors: [{ messageId: 'deep' }] },
    { code: "import { x } from '@bcbp-solutions-fzc-llc/frontend-sdk/internal';", errors: [{ messageId: 'deep' }] },
    { code: "export { x } from '@bcbp-solutions-fzc-llc/frontend-sdk/src/core/index.ts';", errors: [{ messageId: 'deep' }] },
    { code: 'const m = await import(`@bcbp-solutions-fzc-llc/frontend-sdk/http/client`);', errors: [{ messageId: 'deep' }] },
    { code: 'const m = require(`@bcbp-solutions-fzc-llc/frontend-sdk/internal`);', errors: [{ messageId: 'deep' }] },
  ],
});

tester.run('no-identity-headers', rules['no-identity-headers']!, {
  valid: [
    "fetch('/api/x', { headers: { accept: 'application/json', 'x-request-id': id } });",
    "api.get('/t', { headers: { 'Accept-Language': 'ar' } });",
    "map.set('x-user-id-cache', 1);",
    "const o = { 'x-user-id': 1 };", // not a headers object
    'fetch(u, { headers: h });', // not an object literal: nothing to inspect
    "fetch(u, { headers: { [name]: v, 1: 'one', ...base } });", // computed, numeric and spread keys are not names
    "fetch(u, { [`headers${n}`]: { 'x-user-id': u } });", // a built key is not known to be headers
    'new Headers(init);',
    'new Headers();',
    "new Map({ 'x-user-id': u });",
    "headers.set(name, v);",
    "headers.get('x-user-id');",
    "set('x-user-id', u);", // not a method call
    'h[name] = v;', // a computed key that is not a static string
    "h['x-request-id'] = id;",
    'new Headers([[name, v], other]);', // pairs with non-static names, and a non-pair
    "new Headers([['accept', 'text/html']]);",
    "init.body = { 'x-user-id': u };", // not headers
    'headers.set(`x-user-id-${n}`, v);', // a built name is not static
  ],
  invalid: [
    { code: "fetch('/api/x', { headers: { 'x-user-id': u } });", errors: [{ messageId: 'header', data: { name: 'x-user-id' } }] },
    { code: "api.put('/t', { headers: { 'X-Tenant-ID': t, 'x-plan': 'enterprise' } });", errors: 2 },
    { code: "new Headers({ 'x-feature-flags': f });", errors: 1 },
    { code: "headers.set('x-tenant-roles', r);", errors: 1 },
    { code: "h.append('X-Residency-Mode', m);", errors: 1 },
    { code: "fetch(u, { headers: { ['x-departments']: d } });", errors: 1 },
    { code: "fetch(u, { headers: { ...base, 'x-user-id': u } });", errors: [{ messageId: 'header', data: { name: 'x-user-id' } }] },
    { code: "headers['set']('x-plan', p);", errors: [{ messageId: 'header', data: { name: 'x-plan' } }] },
    { code: "fetch(u, { ['headers']: { 'x-user-id': id } });", errors: [{ messageId: 'header', data: { name: 'x-user-id' } }] },
    { code: "fetch(u, { [`headers`]: { [`x-plan`]: p } });", errors: [{ messageId: 'header', data: { name: 'x-plan' } }] },
    // Bypasses: computed assignment, header pairs, template-literal names, assigned headers objects.
    { code: "h['x-user-id'] = v;", errors: [{ messageId: 'header', data: { name: 'x-user-id' } }] },
    { code: 'init.headers[`X-Tenant-Id`] = t;', errors: [{ messageId: 'header', data: { name: 'X-Tenant-Id' } }] },
    { code: "new Headers([['x-user-id', v]]);", errors: [{ messageId: 'header', data: { name: 'x-user-id' } }] },
    { code: "new Headers([['accept', a], ['x-plan', p]] as [string, string][]);", errors: [{ messageId: 'header', data: { name: 'x-plan' } }] },
    { code: "new globalThis.Headers({ 'x-departments': d });", errors: 1 },
    { code: "fetch(u, { headers: [['x-feature-flags', f]] });", errors: [{ messageId: 'header', data: { name: 'x-feature-flags' } }] },
    { code: 'h.set(`x-user-id`, v);', errors: [{ messageId: 'header', data: { name: 'x-user-id' } }] },
    { code: 'h.append(`x-residency-mode`, m);', errors: 1 },
    { code: "init.headers = { 'x-user-id': u };", errors: [{ messageId: 'header', data: { name: 'x-user-id' } }] },
  ],
});

tester.run('no-raw-storage', rules['no-raw-storage']!, {
  valid: [
    "import { storage } from '@bcbp-solutions-fzc-llc/frontend-sdk/storage'; storage('tenders').set('filter', 'open');",
    'const localStorage = new Map(); localStorage.get("x");',
    'obj.localStorage = 1;',
    'window[key].getItem("x");', // a computed member with a non-literal key is not resolved
    'self.indexedDB.open("db");',
    'const w = getWindow(); w.localStorage.clear();', // not the global object
    'let w = window; w = other; w.localStorage.clear();', // reassigned: not an alias
    'function f(window) { return window.localStorage; }', // a parameter shadows the global
    'const { indexedDB } = window;',
    'const { localStorage } = other;',
    'const [first] = window;',
    'const { [key]: s } = window;',
  ],
  invalid: [
    { code: "localStorage.setItem('token', t);", errors: [{ messageId: 'raw' }] },
    { code: "const v = sessionStorage.getItem('draft');", errors: 1 },
    { code: "window.localStorage.clear();", errors: 1 },
    { code: "globalThis['sessionStorage'].removeItem('x');", errors: 1 },
    { code: 'self.localStorage.clear();', errors: [{ messageId: 'raw', data: { name: 'self.localStorage' } }] },
    // Bypasses: aliases of the global object, chains of it, and destructuring.
    { code: 'const w = window; w.localStorage.setItem("k", v);', errors: [{ messageId: 'raw', data: { name: 'w.localStorage' } }] },
    { code: 'const g = globalThis; const h = g; h["sessionStorage"].clear();', errors: [{ messageId: 'raw', data: { name: 'h.sessionStorage' } }] },
    { code: 'let s = self as Window; s.localStorage.clear();', errors: 1 },
    { code: 'window.self.localStorage.clear();', errors: [{ messageId: 'raw', data: { name: 'self.localStorage' } }] },
    { code: 'const { localStorage: ls } = window; ls.clear();', errors: [{ messageId: 'raw', data: { name: 'localStorage' } }] },
    { code: 'const w = window; const { sessionStorage } = w;', errors: 1 },
  ],
});

tester.run('no-unsafe-html', rules['no-unsafe-html']!, {
  valid: [
    `${SANITIZE} el.innerHTML = sanitizeHtml(html);`,
    'el.textContent = text;',
    "import * as security from '@bcbp-solutions-fzc-llc/frontend-sdk/security'; el.insertAdjacentHTML('beforeend', security.sanitizeHtml(html));",
    `${SANITIZE} const a = <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;`,
    "import { sanitizeHtml as clean } from '@bcbp-solutions-fzc-llc/frontend-sdk/security'; el.innerHTML = clean(html) as string;",
    `${SANITIZE} el.setHTMLUnsafe(sanitizeHtml(html));`,
    `${SANITIZE} iframe.srcdoc = sanitizeHtml(html);`,
    `${SANITIZE} const a = <iframe srcDoc={sanitizeHtml(html)} />;`,
    `${SANITIZE} range.createContextualFragment(sanitizeHtml(html));`,
    `${SANITIZE} new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');`,
    "new DOMParser().parseFromString(xml, 'application/xml');",
    "parser.parseFromString(xml, 'text/xml');",
    "iframe.setAttribute('title', html);",
    `${SANITIZE} iframe.setAttribute('srcdoc', sanitizeHtml(html));`,
    { code: 'el.innerHTML = clean(html);', options: [{ sanitizers: ['clean'] }] },
    'html = el.innerHTML;', // reading is fine
    'innerHTML = html;', // a plain variable, not an element property
    'el[prop] = html;',
    'const a = <div title={html} />;',
    'const a = <div {...props} />;',
    'doc.write(html);', // only the global document
    "el.insertAdjacentText('beforeend', text);",
  ],
  invalid: [
    { code: 'el.innerHTML = html;', errors: [{ messageId: 'unsanitized', data: { what: 'innerHTML' } }] },
    { code: "el['outerHTML'] = `<b>${x}</b>`;", errors: 1 },
    { code: "el.insertAdjacentHTML('beforeend', html);", errors: 1 },
    { code: 'document.write(html);', errors: [{ messageId: 'write' }] },
    { code: 'const a = <div dangerouslySetInnerHTML={{ __html: html }} />;', errors: 1 },
    { code: 'const a = <div dangerouslySetInnerHTML={props.html} />;', errors: 1 },
    { code: 'const a = <div dangerouslySetInnerHTML="<b>x</b>" />;', errors: [{ messageId: 'unsanitized', data: { what: 'dangerouslySetInnerHTML' } }] },
    { code: 'const a = <div dangerouslySetInnerHTML={{ html: sanitizeHtml(x) }} />;', errors: 1 }, // no __html
    { code: 'el.innerHTML = factory()(html);', errors: [{ messageId: 'unsanitized', data: { what: 'innerHTML' } }] }, // an anonymous callee is not a sanitizer
    { code: 'el.innerHTML = sanitizeHtml(html);', options: [{ sanitizers: ['clean'] }], errors: 1 }, // the option replaces the default
    { code: 'document.writeln(html);', errors: [{ messageId: 'write', data: { what: 'document.writeln' } }] },
    // Bypasses: other HTML sinks.
    { code: 'el.setHTMLUnsafe(html);', errors: [{ messageId: 'unsanitized', data: { what: 'setHTMLUnsafe' } }] },
    { code: 'Document.parseHTMLUnsafe(html);', errors: [{ messageId: 'unsanitized', data: { what: 'parseHTMLUnsafe' } }] },
    { code: 'iframe.srcdoc = html;', errors: [{ messageId: 'unsanitized', data: { what: 'srcdoc' } }] },
    { code: "iframe.setAttribute('srcdoc', html);", errors: [{ messageId: 'unsanitized', data: { what: 'srcdoc' } }] },
    { code: 'const a = <iframe srcDoc={html} />;', errors: [{ messageId: 'unsanitized', data: { what: 'srcDoc' } }] },
    { code: 'document.createRange().createContextualFragment(html);', errors: [{ messageId: 'unsanitized', data: { what: 'createContextualFragment' } }] },
    { code: "new DOMParser().parseFromString(html, 'text/html');", errors: [{ messageId: 'unsanitized', data: { what: 'DOMParser.parseFromString' } }] },
    { code: 'parser.parseFromString(html, type);', errors: 1 }, // an unknown type may be HTML
    { code: "parser.parseFromString(svg, 'image/svg+xml');", errors: 1 },
    // A sanitizeHtml that is not the SDK's is not trusted.
    { code: 'el.innerHTML = sanitizeHtml(html);', errors: [{ messageId: 'unsanitized', data: { what: 'innerHTML' } }] },
    { code: 'function sanitizeHtml(s) { return s; } el.innerHTML = sanitizeHtml(html);', errors: 1 },
    { code: "import { sanitizeHtml } from './my-security'; el.innerHTML = sanitizeHtml(html);", errors: 1 },
    { code: "import { escape as sanitizeHtml } from '@bcbp-solutions-fzc-llc/frontend-sdk/security'; el.innerHTML = sanitizeHtml(html);", errors: 1 },
    { code: "el.insertAdjacentHTML('beforeend', security.sanitizeHtml(html));", errors: 1 }, // security is not the SDK's namespace
    { code: "import security from '@bcbp-solutions-fzc-llc/frontend-sdk/security'; el.innerHTML = security.sanitizeHtml(html);", errors: 1 },
  ],
});

tester.run('no-runtime-css-in-js', rules['no-runtime-css-in-js']!, {
  valid: [
    "import styles from './Form.module.css';",
    "import { style } from '@vanilla-extract/css';",
    "import { css } from '@linaria/core';",
    { code: "import styled from 'styled-components';", options: [{ allow: ['styled-components'] }] },
    "import x from 'styled-components-like';",
    "import { styled } from '@stitches/react-extra';",
  ],
  invalid: [
    { code: "import styled from '@emotion/styled';", errors: [{ messageId: 'css' }] },
    { code: "import styled from 'styled-components';", errors: 1 },
    { code: "import { Button } from '@mui/material';", errors: 1 },
    { code: "import { assignInlineVars } from '@vanilla-extract/dynamic';", errors: 1 },
    { code: "import { css } from 'styled-components/macro';", options: [{ allow: ['styled-components'] }], errors: [{ messageId: 'css', data: { source: 'styled-components/macro' } }] },
    { code: "const m = await import('goober');", errors: 1 },
    { code: "export { styled } from '@stitches/react';", errors: 1 },
    { code: "const s = require('styled-jsx/style');", errors: 1 },
    { code: 'const s = require(`styled-components`);', errors: [{ messageId: 'css', data: { source: 'styled-components' } }] },
  ],
});

tester.run('api-route-template', rules['api-route-template']!, {
  valid: [
    "api.get('/tenders/:id', { params: { id } });",
    "c.post('/tenders', { body });",
    'cache.get(`${tenant}:${key}`);',
    'map.delete(prefix + key);',
    'api.get(TEMPLATES.tender);',
    'api.get();',
    'api.fetch(`/tenders/${id}`);', // not an ApiClient method
    'get(`/tenders/${id}`);', // not a method call
    'api.get(`/tenders/:id`);', // a template literal without expressions is a template
    "api.get(base + '/tenders');", // leftmost part is not a path
    'api.get(`${base}/tenders`);',
    "api.get(id * '/x');",
    "api[method](`/tenders/${id}`);",
  ],
  invalid: [
    { code: 'api.get(`/tenders/${id}`);', errors: [{ messageId: 'template' }] },
    { code: "client.delete('/tenders/' + id);", errors: 1 },
    { code: "api.patch(`/tenders/${id}/items/` + item, { body });", errors: 1 },
    { code: "api.put('/tenders/' + id + '/items', { body });", errors: 1 },
    { code: "api['post'](`/tenders/${id}/bids`);", errors: 1 },
  ],
});

describe('plugin', () => {
  it('links every rule to the reference on GitHub with an absolute URL', () => {
    for (const [name, r] of Object.entries(rules)) expect(r.meta?.docs?.url, name).toBe(DOCS_URL);
    expect(DOCS_URL).toMatch(/^https:\/\/github\.com\/BCBP-SOLUTIONS-FZC-LLC\/platform-reactcommon\/blob\/main\/docs\/lld\/platform-reactcommon-lld\.md#132-/);
  });

  it('uses the same identity-header list as the SDK', () => {
    expect(PLUGIN_FORBIDDEN).toEqual(FORBIDDEN_REQUEST_HEADERS);
  });

  it('configs.recommended turns on every rule and the CSP core rules', () => {
    const linter = new Linter();
    const messages = linter.verify(
      [
        "import { getLogger } from '@bcbp-solutions-fzc-llc/frontend-sdk';",
        "localStorage.setItem('k', 'v');",
        'eval(code);',
        "const f = new Function('return 1');",
        "setTimeout('alert(1)', 10);",
      ].join('\n'),
      [plugin.configs.recommended, { languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { setTimeout: 'readonly' } } }],
    );
    expect(messages.map((m) => m.ruleId).sort()).toEqual(
      ['@bcbp-solutions-fzc-llc/no-raw-storage', '@bcbp-solutions-fzc-llc/no-sdk-root-import', 'no-eval', 'no-implied-eval', 'no-new-func'].sort(),
    );
    expect(Object.keys(plugin.configs.recommended.rules!)).toHaveLength(Object.keys(rules).length + 3);
  });
});
