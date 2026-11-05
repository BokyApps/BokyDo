import { describe, expect, it } from 'vitest';
import { createMcpConnectionPrompt } from './mcp-connection.js';

describe('createMcpConnectionPrompt', () => {
  it('provides sign-in instructions without PAT fallback when sign-in only is allowed', () => {
    const prompt = createMcpConnectionPrompt('https://todo.example/', 'sign-in');
    expect(prompt).toContain('https://todo.example/mcp');
    expect(prompt).toContain('OAuth with PKCE');
    expect(prompt).toContain('sign-in authentication only');
    expect(prompt).not.toContain('create a suitably scoped personal access token');
    expect(prompt).not.toContain('Bearer ');
  });

  it('offers a secure PAT fallback when both methods are allowed', () => {
    const prompt = createMcpConnectionPrompt('https://todo.example', 'both');
    expect(prompt).toContain('If this client cannot complete OAuth');
    expect(prompt).toContain('secure credential store');
    expect(prompt).not.toMatch(/bkd_(?:pat|at|rt)_[A-Za-z0-9_-]+/);
  });

  it('makes PAT required when PAT-only is configured', () => {
    const prompt = createMcpConnectionPrompt('https://todo.example', 'pat');
    expect(prompt).toContain('requires a personal access token for MCP');
    expect(prompt).toContain('Authorization: Bearer credential');
    expect(prompt).not.toContain('Try browser sign-in first');
  });
});
