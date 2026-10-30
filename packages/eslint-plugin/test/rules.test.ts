import { Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import plugin, { rules } from '../src/index.ts';
import { FORBIDDEN_REQUEST_HEADERS } from '../../frontend-sdk/src/internal/generated/forbidden-headers.ts';
import { FORBIDDEN_REQUEST_HEADERS as PLUGIN_FORBIDDEN } from '../src/generated/forbidden-headers.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } }, ecmaVersion: 'latest', sourceType: 'module' },
});

tester.run('no-sdk-root-import', rules['no-sdk-root-import']!, {
  valid: ["import { getLogger } from '@platform/frontend-sdk/logging';", "import x from '@platform/frontend-sdk-extra';"],
  invalid: [
    { code: "import { getLogger } from '@platform/frontend-sdk';", errors: [{ messageId: 'root' }] },
    { code: "export * from '@platform/frontend-sdk';", errors: [{ messageId: 'root' }] },
    { code: "const m = await import('@platform/frontend-sdk');", errors: [{ messageId: 'root' }] },
    { code: "const m = require('@platform/frontend-sdk');", errors: [{ messageId: 'root' }] },
  ],
});

tester.run('no-sdk-deep-import', rules['no-sdk-deep-import']!, {
  valid: [
    "import { createApiClient } from '@platform/frontend-sdk/http';",
    "import { createTestPlatform } from '@platform/frontend-sdk/testing';",
    "import pkg from '@platform/frontend-sdk/package.json';",
  ],
  invalid: [
    { code: "import { x } from '@platform/frontend-sdk/http/client';", errors: [{ messageId: 'deep' }] },
    { code: "import { x } from '@platform/frontend-sdk/dist/http/index.js';", errors: [{ messageId: 'deep' }] },
    { code: "import { x } from '@platform/frontend-sdk/internal';", errors: [{ messageId: 'deep' }] },
    { code: "export { x } from '@platform/frontend-sdk/src/core/index.ts';", errors: [{ messageId: 'deep' }] },
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
    "fetch(u, { ['headers']: { 'x-user-id': u } });", // a computed `headers` key is not recognised
    'new Headers(init);',
    'new Headers();',
    "new Map({ 'x-user-id': u });",
    "headers.set(name, v);",
    "headers.get('x-user-id');",
    "set('x-user-id', u);", // not a method call
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
  ],
});

tester.run('no-raw-storage', rules['no-raw-storage']!, {
  valid: [
    "import { storage } from '@platform/frontend-sdk/storage'; storage('tenders').set('filter', 'open');",
    'const localStorage = new Map(); localStorage.get("x");',
    'obj.localStorage = 1;',
    'window[key].getItem("x");', // a computed member with a non-literal key is not resolved
    'self.indexedDB.open("db");',
  ],
  invalid: [
    { code: "localStorage.setItem('token', t);", errors: [{ messageId: 'raw' }] },
    { code: "const v = sessionStorage.getItem('draft');", errors: 1 },
    { code: "window.localStorage.clear();", errors: 1 },
    { code: "globalThis['sessionStorage'].removeItem('x');", errors: 1 },
    { code: 'self.localStorage.clear();', errors: [{ messageId: 'raw', data: { name: 'self.localStorage' } }] },
  ],
});

tester.run('no-unsafe-html', rules['no-unsafe-html']!, {
  valid: [
    'el.innerHTML = sanitizeHtml(html);',
    'el.textContent = text;',
    "el.insertAdjacentHTML('beforeend', security.sanitizeHtml(html));",
    'const a = <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;',
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
  it('uses the same identity-header list as the SDK', () => {
    expect(PLUGIN_FORBIDDEN).toEqual(FORBIDDEN_REQUEST_HEADERS);
  });

  it('configs.recommended turns on every rule and the CSP core rules', () => {
    const linter = new Linter();
    const messages = linter.verify(
      [
        "import { getLogger } from '@platform/frontend-sdk';",
        "localStorage.setItem('k', 'v');",
        'eval(code);',
        "const f = new Function('return 1');",
        "setTimeout('alert(1)', 10);",
      ].join('\n'),
      [plugin.configs.recommended, { languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { setTimeout: 'readonly' } } }],
    );
    expect(messages.map((m) => m.ruleId).sort()).toEqual(
      ['@platform/no-raw-storage', '@platform/no-sdk-root-import', 'no-eval', 'no-implied-eval', 'no-new-func'].sort(),
    );
    expect(Object.keys(plugin.configs.recommended.rules!)).toHaveLength(Object.keys(rules).length + 3);
  });
});
