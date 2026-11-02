// The shell's session screens (design doc §C1 /auth, §C2 step 7). None of them signs in on its own:
// every login starts from the user's click.
import type { IdentityProvider, SessionState } from '@bcbp-solutions-fzc-llc/frontend-sdk/auth';
import { askForWorkspace } from './IdentifierFirst';
import { hideScreen, showScreen } from './screen';

/** After a logout: never log in automatically, or the live SSO session would undo the logout. */
export function showSignedOut(signIn: () => Promise<void>): void {
  showScreen(
    <div role="dialog" aria-labelledby="signed-out-title">
      <h1 id="signed-out-title">You are signed out</h1>
      <button type="button" onClick={() => void signIn()}>
        Sign in
      </button>
    </div>,
  );
}

/**
 * The sign-in was refused because the device clock is far off (reason 'device-clock'): another
 * attempt would fail the same way until the user sets it. No automatic retry.
 */
export function showDeviceClock(signIn: () => Promise<void>): void {
  showScreen(
    <div role="alertdialog" aria-labelledby="clock-title">
      <h1 id="clock-title">Check your device's clock</h1>
      <p>We couldn't sign you in because this device's date or time is wrong. Set it to update automatically, then try again.</p>
      <button type="button" onClick={() => void signIn()}>
        Try again
      </button>
    </div>,
  );
}

/** Expired during use. serverEnded covers trial → paid conversion ("your workspace has moved"). */
export function showSessionEnded(s: Extract<SessionState, { status: 'expired' }>, signIn: () => Promise<void>): void {
  const text = s.serverEnded
    ? 'Your session was ended. If your workspace has moved to its own plan, sign in again to continue there.'
    : s.idle
      ? 'You were signed out after a period of inactivity.'
      : 'Your session has ended.';
  showScreen(
    <div role="alertdialog" aria-modal="true" aria-labelledby="ended-title">
      <h1 id="ended-title">Session ended</h1>
      <p>{text}</p>
      <button
        type="button"
        onClick={() => {
          hideScreen();
          void signIn();
        }}
      >
        Sign in
      </button>
    </div>,
  );
}

/** A trial login that landed in another tenant than the invitation's: never cached, app not rendered. */
export function showWrongWorkspace(idp: IdentityProvider): void {
  showScreen(
    <div role="alertdialog" aria-labelledby="wrong-title">
      <h1 id="wrong-title">You signed in to a different workspace</h1>
      <p>The account you used belongs to another workspace than the one you were invited to.</p>
      <button type="button" onClick={() => void idp.logout()}>
        Sign out
      </button>
      <button type="button" onClick={() => void askForWorkspace().then((w) => idp.switchWorkspace(w))}>
        Switch workspace
      </button>
    </div>,
  );
}
