/**
 * A /join#token link opened while signed out: the token travels in the URL fragment and waits in
 * this tab's sessionStorage across the trip through sign-in. Kept in its own small module so the
 * start-up code doesn't pull in the sharing pages (they are lazy-loaded).
 */
const JOIN_KEY = 'bokydo.join';

export function stashJoinToken(): void {
  if (location.pathname !== '/join' || location.hash.length < 2) return;
  try {
    sessionStorage.setItem(JOIN_KEY, location.hash.slice(1));
  } catch {
    // storage unavailable: the user can open the link again after signing in
  }
}

export function pendingJoinToken(): string | null {
  try {
    return sessionStorage.getItem(JOIN_KEY);
  } catch {
    return null;
  }
}

export function clearJoinToken(): void {
  try {
    sessionStorage.removeItem(JOIN_KEY);
  } catch {
    // nothing to clear
  }
}
