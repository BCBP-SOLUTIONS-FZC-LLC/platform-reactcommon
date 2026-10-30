// Module Federation needs an async boundary before shared modules are used (design doc §C2).
// Steps 2–3 (identity, runtime config) are fatal: a static page, console only.
import('./bootstrap').then(
  (m) => m.bootstrap(),
).catch((e: unknown) => {
  console.error('the app could not start', e);
  const p = document.createElement('p');
  p.setAttribute('role', 'alert');
  p.textContent = 'The app is unavailable right now. Please try again later.';
  document.getElementById('root')?.replaceChildren(p);
});
