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
  ],
  invalid: [
    { code: "fetch('/api/x', { headers: { 'x-user-id': u } });", errors: [{ messageId: 'header', data: { name: 'x-user-id' } }] },
    { code: "api.put('/t', { headers: { 'X-Tenant-ID': t, 'x-plan': 'enterprise' } });", errors: 2 },
    { code: "new Headers({ 'x-feature-flags': f });", errors: 1 },
    { code: "headers.set('x-tenant-roles', r);", errors: 1 },
    { code: "h.append('X-Residency-Mode', m);", errors: 1 },
    { code: "fetch(u, { headers: { ['x-departments']: d } });", errors: 1 },
  ],
});

tester.run('no-raw-storage', rules['no-raw-storage']!, {
  valid: [
    "import { storage } from '@platform/frontend-sdk/storage'; storage('tenders').set('filter', 'open');",
    'const localStorage = new Map(); localStorage.get("x");',
    'obj.localStorage = 1;',
  ],
  invalid: [
    { code: "localStorage.setItem('token', t);", errors: [{ messageId: 'raw' }] },
    { code: "const v = sessionStorage.getItem('draft');", errors: 1 },
    { code: "window.localStorage.clear();", errors: 1 },
    { code: "globalThis['sessionStorage'].removeItem('x');", errors: 1 },
  ],
});

tester.run('no-unsafe-html', rules['no-unsafe-html']!, {
  valid: [
    'el.innerHTML = sanitizeHtml(html);',
    'el.textContent = text;',
    "el.insertAdjacentHTML('beforeend', security.sanitizeHtml(html));",
    'const a = <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;',
    { code: 'el.innerHTML = clean(html);', options: [{ sanitizers: ['clean'] }] },
  ],
  invalid: [
    { code: 'el.innerHTML = html;', errors: [{ messageId: 'unsanitized', data: { what: 'innerHTML' } }] },
    { code: "el['outerHTML'] = `<b>${x}</b>`;", errors: 1 },
    { code: "el.insertAdjacentHTML('beforeend', html);", errors: 1 },
    { code: 'document.write(html);', errors: [{ messageId: 'write' }] },
    { code: 'const a = <div dangerouslySetInnerHTML={{ __html: html }} />;', errors: 1 },
    { code: 'const a = <div dangerouslySetInnerHTML={props.html} />;', errors: 1 },
  ],
});

tester.run('no-runtime-css-in-js', rules['no-runtime-css-in-js']!, {
  valid: [
    "import styles from './Form.module.css';",
    "import { style } from '@vanilla-extract/css';",
    "import { css } from '@linaria/core';",
    { code: "import styled from 'styled-components';", options: [{ allow: ['styled-components'] }] },
  ],
  invalid: [
    { code: "import styled from '@emotion/styled';", errors: [{ messageId: 'css' }] },
    { code: "import styled from 'styled-components';", errors: 1 },
    { code: "import { Button } from '@mui/material';", errors: 1 },
    { code: "import { assignInlineVars } from '@vanilla-extract/dynamic';", errors: 1 },
  ],
});

tester.run('api-route-template', rules['api-route-template']!, {
  valid: [
    "api.get('/tenders/:id', { params: { id } });",
    "c.post('/tenders', { body });",
    'cache.get(`${tenant}:${key}`);',
    'map.delete(prefix + key);',
    'api.get(TEMPLATES.tender);',
  ],
  invalid: [
    { code: 'api.get(`/tenders/${id}`);', errors: [{ messageId: 'template' }] },
    { code: "client.delete('/tenders/' + id);", errors: 1 },
    { code: "api.patch(`/tenders/${id}/items/` + item, { body });", errors: 1 },
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
