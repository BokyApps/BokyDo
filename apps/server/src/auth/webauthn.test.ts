import { describe, expect, it } from 'vitest';
import type { SettingsService } from '../settings/settings-service.js';
import { relyingParty } from './webauthn.js';

const settings = (publicUrl: string | null) =>
  ({
    get: (k: string) => (k === 'instance.publicUrl' ? publicUrl : 'BokyDo'),
  }) as unknown as SettingsService;

describe('relyingParty', () => {
  it.each([
    ['https://tasks.example.com', 'tasks.example.com'],
    ['http://localhost:8080', 'localhost'],
    ['http://bokydo.localhost', 'bokydo.localhost'],
  ])('%s → RP ID %s', (url, id) => {
    expect(relyingParty(settings(url))).toEqual({
      id,
      name: 'BokyDo',
      origin: new URL(url).origin,
    });
  });

  it.each([
    null,
    'http://tasks.example.com',
    'http://127.0.0.1:8080',
    'https://192.168.1.10',
    'https://[::1]:8443',
  ])('no passkeys for %s', (url) => {
    expect(relyingParty(settings(url))).toBeNull();
  });
});
