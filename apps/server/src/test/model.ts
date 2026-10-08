import type { OutboundFetch, OutboundResponse } from '../net/outbound.js';

/** A scripted model reply: text, or tool calls. */
export type ScriptedReply = string | { calls: { name: string; args: Record<string, unknown> }[] };

export interface SentRequest {
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[];
  tools?: { function: { name: string } }[];
  /** The system and first user message, for quick assertions. */
  system: string;
  user: string;
}

/**
 * An OpenAI-style chat endpoint for users' own credentials (testApp `aiUserFetch`): answers
 * from a script and records every request.
 */
export function fakeModel() {
  const replies: ScriptedReply[] = [];
  const seen: SentRequest[] = [];
  let n = 0;
  const fetch: OutboundFetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body)) as Omit<SentRequest, 'system' | 'user'>;
    seen.push({
      ...body,
      system: body.messages.find((m) => m.role === 'system')?.content ?? '',
      user: body.messages.find((m) => m.role === 'user')?.content ?? '',
    });
    const next = replies.shift() ?? 'Done.';
    const message =
      typeof next === 'string'
        ? { content: next }
        : {
            content: null,
            tool_calls: next.calls.map((c) => ({
              id: `call_${++n}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          };
    const text = JSON.stringify({
      choices: [{ message, finish_reason: typeof next === 'string' ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    const res: OutboundResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: (async function* () {
        yield Buffer.from(text);
      })(),
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
      cancel: () => undefined,
    };
    return res;
  };
  return { fetch, replies, seen };
}
