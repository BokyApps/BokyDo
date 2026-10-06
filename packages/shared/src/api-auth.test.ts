import { describe, expect, it } from 'vitest';
import { parseScopeString, redirectUriIssue, redirectUriMatches } from './api-auth.js';

describe('redirect URIs', () => {
  it('accepts https, loopback http and reverse-domain app schemes only', () => {
    for (const ok of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://example.com/cb?x=1',
      'http://127.0.0.1:33418/callback',
      'http://localhost:6274/oauth/callback',
      'http://[::1]/cb',
      'com.bokyapps.bokydo:/oauth2redirect',
    ]) {
      expect(redirectUriIssue(ok), ok).toBeNull();
    }
    for (const bad of [
      'http://example.com/cb',
      'http://127.0.0.1.evil.example/cb',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'vbscript:x',
      'myapp://cb',
      'https://example.com/cb#x',
      'https://a:b@example.com/cb',
      'not a url',
      `https://example.com/${'a'.repeat(600)}`,
    ]) {
      expect(redirectUriIssue(bad), bad).not.toBeNull();
    }
  });

  it('matches exactly, except the port of loopback redirects', () => {
    expect(redirectUriMatches('https://a.example/cb', 'https://a.example/cb')).toBe(true);
    expect(redirectUriMatches('https://a.example/cb', 'https://a.example/cb/')).toBe(false);
    expect(redirectUriMatches('https://a.example/cb', 'https://a.example:8443/cb')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:51000/cb')).toBe(true);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://localhost:51000/cb')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:51000/other')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://u@127.0.0.1:51000/cb')).toBe(false);
  });
});

describe('scope strings', () => {
  it('parses known scopes and rejects anything else', () => {
    expect(parseScopeString('tasks:read  tasks:read sync')).toEqual(['tasks:read', 'sync']);
    expect(parseScopeString('tasks:read admin')).toBeNull();
    expect(parseScopeString('')).toEqual([]);
  });
});
