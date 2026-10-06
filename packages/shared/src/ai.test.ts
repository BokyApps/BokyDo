import { describe, expect, it } from 'vitest';
import {
  aiCredentialCreateSchema,
  aiRoutingSchema,
  normalizeAiBaseUrl,
  privateAllowlistEntrySchema,
  providerSupports,
} from './ai.js';

describe('AI schemas', () => {
  it('normalises base URLs and rejects credentials, queries and odd schemes', () => {
    expect(normalizeAiBaseUrl('https://host.example/v1/')).toBe('https://host.example/v1');
    expect(normalizeAiBaseUrl('http://ollama:11434')).toBe('http://ollama:11434');
    for (const bad of ['ftp://x/', 'https://u:p@x/', 'https://x/?a=1', 'https://x/#f', 'x']) {
      expect(normalizeAiBaseUrl(bad), bad).toBeNull();
    }
  });

  it('applies provider rules to new credentials', () => {
    const ok = (v: unknown) => aiCredentialCreateSchema.safeParse(v).success;
    expect(ok({ provider: 'openai', label: 'a', apiKey: 'sk-1' })).toBe(true);
    expect(ok({ provider: 'openai', label: 'a' })).toBe(false);
    expect(ok({ provider: 'openai', label: 'a', apiKey: 'k', baseUrl: 'https://x/v1' })).toBe(
      false,
    );
    expect(ok({ provider: 'ollama', label: 'a' })).toBe(false);
    expect(ok({ provider: 'ollama', label: 'a', baseUrl: 'http://ollama:11434/v1' })).toBe(true);
    expect(
      ok({
        provider: 'openai-compatible',
        label: 'a',
        baseUrl: 'https://x/v1',
        headers: { 'X-Org': '1' },
      }),
    ).toBe(true);
    for (const name of ['Host', 'cookie', 'Content-Length', 'bad name']) {
      expect(
        ok({
          provider: 'openai-compatible',
          label: 'a',
          baseUrl: 'https://x/v1',
          headers: { [name]: '1' },
        }),
        name,
      ).toBe(false);
    }
    expect(
      ok({
        provider: 'openai-compatible',
        label: 'a',
        baseUrl: 'https://x/v1',
        headers: { a: 'x\r\nb: y' },
      }),
    ).toBe(false);
    expect(ok({ provider: 'openai', label: 'a', apiKey: 'has space' })).toBe(false);
    expect(ok({ provider: 'nope', label: 'a' })).toBe(false);
  });

  it('routes features to capable providers only', () => {
    expect(providerSupports('anthropic', 'chat.structured')).toBe(true);
    expect(providerSupports('anthropic', 'decision')).toBe(true); // structured-chat fallback
    expect(providerSupports('anthropic', 'stt.batch')).toBe(false);
    expect(
      aiRoutingSchema.safeParse({ unknown: { credentialId: crypto.randomUUID(), model: 'm' } })
        .success,
    ).toBe(false);
  });

  it('accepts CIDRs and hostnames in the private allow-list', () => {
    const ok = (v: string) => privateAllowlistEntrySchema.safeParse(v).success;
    for (const v of ['10.0.0.0/8', 'fd00::/8', '192.168.1.5', 'ollama', 'gpu-box.lan'])
      expect(ok(v), v).toBe(true);
    for (const v of ['localhost', 'a.localhost', '10.0.0.1/8', '127.1', 'http://x', 'a b'])
      expect(ok(v), v).toBe(false);
    expect(privateAllowlistEntrySchema.parse(' Ollama ')).toBe('ollama');
  });
});
