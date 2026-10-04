import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from './api.js';

export const browserSupportsPasskeys = () =>
  typeof window !== 'undefined' && 'PublicKeyCredential' in window;

/** Run a WebAuthn ceremony: fetch options, ask the authenticator, post the result. */
export async function passkeyAssertion<T>(optionsPath: string, verifyPath: string): Promise<T> {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
    'POST',
    optionsPath,
  );
  const response = await startAuthentication({ optionsJSON });
  return api<T>('POST', verifyPath, { response });
}

export async function registerPasskey(
  name: string,
): Promise<{ id: string; recoveryCodes: string[] | null }> {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>(
    'POST',
    '/api/v1/account/passkeys/options',
  );
  const response = await startRegistration({ optionsJSON });
  return api('POST', '/api/v1/account/passkeys', { response, name });
}
