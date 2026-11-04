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

it('removes the form (and the ID token in it) once the page leaves, or after 10 s', () => {
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    document.body.replaceChildren();
    postNavigate('https://idp.example/logout', { id_token_hint: 'eyJ.a.b' });
    window.dispatchEvent(new Event('pagehide'));
    expect(document.querySelector('form')).toBeNull();
    postNavigate('https://idp.example/logout', { id_token_hint: 'eyJ.a.b' }); // a POST the CSP blocked: no pagehide
    expect(document.querySelector('form')).not.toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(document.querySelector('form')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
