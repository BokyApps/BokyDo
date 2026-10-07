/**
 * An app's sign-in request arrives at /oauth/consent#<handle>. If the person isn't signed in yet,
 * the handle waits in this tab's sessionStorage until they are, then they're brought back.
 */
const KEY = 'bokydo.oauthRequest';

/** Move the handle from the URL fragment into this tab's storage (and out of history). */
export function stashOAuthRequest(): void {
  const handle = location.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) return;
  try {
    sessionStorage.setItem(KEY, handle);
  } catch {
    // Storage unavailable: the consent page will say the request is missing.
  }
  history.replaceState(null, '', location.pathname);
}

export function pendingOAuthRequest(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearOAuthRequest(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Where to go once signed in: back to a waiting app sign-in, or home. */
export function afterSignIn(): '/oauth/consent' | '/' {
  return pendingOAuthRequest() ? '/oauth/consent' : '/';
}
