import { createHash } from 'node:crypto';

/**
 * Have I Been Pwned "range" check (k-anonymity): only the first 5 hex chars of the SHA-1 leave the
 * server, with response padding so even the result size reveals nothing. Fails open (returns
 * false) when the service is unreachable, because a third-party outage must not block sign-ups.
 */
export async function isBreachedPassword(
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'BokyDo' },
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!res.ok) return false;
    const body = await res.text();
    if (body.length > 2_000_000) return false;
    return body.split('\n').some((line) => {
      const [s, count] = line.trim().split(':');
      return s === suffix && Number(count) > 0;
    });
  } catch {
    return false;
  }
}
