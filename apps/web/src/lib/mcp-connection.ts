export type McpAuthMode = 'both' | 'sign-in' | 'pat';

/** A client-neutral set of instructions that never contains a credential. */
export function createMcpConnectionPrompt(origin: string, mode: McpAuthMode): string {
  const endpoint = `${origin.replace(/\/$/, '')}/mcp`;
  const lines = [`Connect to the BokyDo MCP server at ${endpoint} using Streamable HTTP.`];

  if (mode === 'both' || mode === 'sign-in') {
    lines.push(
      'Try browser sign-in first: use the server authorization metadata and discovery flow, start OAuth with PKCE, request only the scopes needed, and let the user review and approve access in the browser.',
      'Do not ask the user for their password. Do not claim sign-in is supported if this client cannot complete the browser OAuth flow.',
    );
  }

  if (mode === 'both' || mode === 'pat') {
    lines.push(
      mode === 'pat'
        ? 'This server requires a personal access token for MCP. Ask the user to create a suitably scoped token in Settings → API & MCP, then configure it as an Authorization: Bearer credential in the client’s secure credential store.'
        : 'If this client cannot complete OAuth and the user wants to continue, ask whether they want to create a suitably scoped personal access token in Settings → API & MCP, then configure it as an Authorization: Bearer credential in the client’s secure credential store.',
      'Never put a token in this prompt, a URL, or an unprotected configuration file.',
    );
  } else {
    lines.push(
      'This server allows sign-in authentication only for MCP; do not request or use a personal access token for MCP.',
    );
  }

  return lines.join('\n');
}
