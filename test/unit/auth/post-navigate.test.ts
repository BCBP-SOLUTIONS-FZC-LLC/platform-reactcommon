// @vitest-environment happy-dom
// The sign-out's form POST (review: id_token_hint in the logout URL): the fields go in the body.
import { expect, it, vi } from 'vitest';
import { postNavigate } from '../../../packages/frontend-sdk/src/auth/oidc.ts';

it('submits a hidden POST form with the fields as hidden inputs, nothing in the action URL', () => {
  const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
  postNavigate('https://idp.example/realms/r/protocol/openid-connect/logout', { id_token_hint: 'eyJ.a.b', client_id: 'web' });
  const form = document.querySelector('form')!;
  expect(submit).toHaveBeenCalledOnce();
  expect(form.method).toBe('post');
  expect(form.action).toBe('https://idp.example/realms/r/protocol/openid-connect/logout');
  expect(form.style.display).toBe('none');
  expect(Object.fromEntries([...form.querySelectorAll('input')].map((i) => [i.name, [i.type, i.value]]))).toEqual({
    id_token_hint: ['hidden', 'eyJ.a.b'],
    client_id: ['hidden', 'web'],
  });
});
