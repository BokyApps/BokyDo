import type { AiProvider } from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import type { UsableCredential } from './credentials.js';
import { liveProvider } from './live.js';

const credential = (
  provider: AiProvider,
  baseUrl: string,
  apiKey = 'sk-test',
): UsableCredential => ({
  id: 'cred',
  ownerUserId: null,
  provider,
  baseUrl,
  apiKey,
  headers: { 'x-custom': '1' },
});

describe('live providers', () => {
  it('builds the OpenAI Realtime URL and keeps the key in the handshake', () => {
    const provider = liveProvider('openai');
    expect(provider?.sampleRate).toBe(24_000);
    expect(provider?.url(credential('openai', 'https://api.openai.com/v1'), 'gpt-realtime')).toBe(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime',
    );
    expect(provider?.headers(credential('openai', 'https://api.openai.com/v1'))).toMatchObject({
      authorization: 'Bearer sk-test',
      'openai-beta': 'realtime=v1',
      'x-custom': '1',
    });
  });

  it('builds the Gemini Live URL and uses the header, not a query parameter', () => {
    const provider = liveProvider('gemini');
    expect(provider?.sampleRate).toBe(16_000);
    const url = provider?.url(
      credential('gemini', 'https://generativelanguage.googleapis.com/v1beta'),
      'models/gemini-2.0-flash-live',
    );
    expect(url).toBe(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
    );
    expect(url).not.toContain('sk-test');
    expect(
      provider?.headers(credential('gemini', 'https://generativelanguage.googleapis.com/v1beta')),
    ).toMatchObject({ 'x-goog-api-key': 'sk-test' });
  });

  it('has no live adapter for a provider that cannot do realtime audio', () => {
    expect(liveProvider('anthropic')).toBeNull();
  });
});
