import {
  rambleLiveClientMessageSchema,
  RAMBLE_LIVE,
  type RambleDraftTask,
  type RambleLiveClientMessage,
  type RambleLiveCloseReason,
  type RambleLiveServerMessage,
} from '@bokydo/shared';
import type { WebSocket } from 'ws';
import { liveProvider, type LiveSession } from '../ai/live.js';
import type { UsableCredential } from '../ai/credentials.js';
import type { AiService, AiUser } from '../ai/service.js';
import { AiBudgetExceededError, remainingBudget, reserveUsage, settleUsage } from '../ai/usage.js';
import type { Database } from '../db/client.js';
import type { LiveConnector } from '../net/outbound-ws.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { ProjectScope } from '../sync/policy.js';
import { loadRambleContext } from './ramble.js';

export interface LiveRelayDeps {
  db: Database;
  settings: SettingsService;
  ai: AiService;
  /** How to reach the provider. Injectable so tests can point at a fake provider. */
  connect: LiveConnector;
}

/** Who the relay is acting for, plus a way to re-check the login mid-session. */
export interface LiveCaller {
  user: AiUser;
  scope: ProjectScope;
  stillValid: () => Promise<boolean>;
}

/**
 * Live Ramble (W8-live, ADR 0014): the browser streams PCM audio; the server holds the provider
 * key, relays to OpenAI Realtime / Gemini Live, applies the same draft edit operations as
 * `/ramble/extract` and streams the draft back. The session is bound to the caller's login
 * (re-checked on a timer), capped in length and audio, and its whole worst-case cost is reserved
 * against the AI budget before the provider socket opens, so a second session can't overrun a
 * budget mid-stream. The key never leaves the server.
 */
export async function relayLive(
  client: WebSocket,
  caller: LiveCaller,
  deps: LiveRelayDeps,
): Promise<void> {
  const { db, ai, connect } = deps;
  const aborter = new AbortController();
  let providerSocket: WebSocket | null = null;
  let session: LiveSession | null = null;
  let rate = 0;
  let capSeconds: number = RAMBLE_LIVE.maxSeconds;
  let usageId: string | null = null;
  let started = 0;
  let audioBytes = 0;
  let closed = false;
  const timers: { revalidate?: NodeJS.Timeout; cap?: NodeJS.Timeout } = {};
  const pending: RambleLiveClientMessage[] = [];
  // The client's first frame carries the draft it already has. The relay waits briefly for it so
  // a live session edits that draft instead of starting from nothing.
  let startDraft: RambleDraftTask[] = [];
  let sawStart = false;
  let onStart: (() => void) | null = null;

  const send = (message: RambleLiveServerMessage) => {
    if (client.readyState === 1) client.send(JSON.stringify(message));
  };
  const audioSeconds = () => (rate === 0 ? 0 : audioBytes / (2 * rate));

  const finish = async (reason: RambleLiveCloseReason, status: 'done' | 'failed') => {
    if (closed) return;
    closed = true;
    onStart = null;
    aborter.abort();
    if (timers.revalidate) clearInterval(timers.revalidate);
    if (timers.cap) clearTimeout(timers.cap);
    try {
      providerSocket?.close(1000, reason.slice(0, 120));
    } catch {
      // The socket is already gone.
    }
    if (usageId !== null) {
      const id = usageId;
      usageId = null;
      await settleUsage(db, id, status, {
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: audioSeconds(),
      }).catch(() => undefined);
    }
    send({ type: 'closed', reason });
    try {
      client.close(1000, reason.slice(0, 120));
    } catch {
      // The client is already gone.
    }
  };

  client.on('close', () => {
    void finish('client_closed', 'failed');
  });

  const handle = (message: RambleLiveClientMessage) => {
    if (Date.now() - started > capSeconds * 1000) {
      void finish('session_too_long', 'done');
      return;
    }
    switch (message.type) {
      case 'audio': {
        const bytes = Buffer.from(message.data, 'base64');
        if (bytes.length === 0 || bytes.length > RAMBLE_LIVE.maxAudioBytes) {
          void finish('too_much_audio', 'done');
          return;
        }
        audioBytes += bytes.length;
        if (audioBytes > RAMBLE_LIVE.maxSessionAudioBytes) {
          void finish('too_much_audio', 'done');
          return;
        }
        session?.sendAudio(message.data);
        return;
      }
      case 'text':
        session?.sendText(message.text);
        return;
      case 'stop':
        session?.stop();
        void finish('done', 'done');
        return;
      default:
    }
  };

  client.on('message', (data) => {
    if (closed) return;
    const text =
      typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : null;
    if (text === null || text.length > RAMBLE_LIVE.maxMessageChars) {
      send({ type: 'error', code: 'invalid_message' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      send({ type: 'error', code: 'invalid_message' });
      return;
    }
    const ok = rambleLiveClientMessageSchema.safeParse(parsed);
    if (!ok.success) {
      send({ type: 'error', code: 'invalid_message' });
      return;
    }
    if (ok.data.type === 'start') {
      if (!sawStart) {
        sawStart = true;
        startDraft = ok.data.draft;
        onStart?.();
      }
      return;
    }
    if (session) handle(ok.data);
    else if (pending.length < 64) pending.push(ok.data);
  });

  const route = await ai.resolve(caller.user, 'ramble.live');
  const provider = route ? liveProvider(route.credential.provider) : null;
  if (!route || !provider) {
    send({ type: 'error', code: 'ai_not_configured' });
    await finish('not_configured', 'failed');
    return;
  }
  let credential: UsableCredential;
  try {
    credential = await ai.fresh(route.credential);
  } catch {
    await finish('provider_error', 'failed');
    return;
  }
  // The session may not be longer than the audio the user can still afford: the reservation
  // below holds that much of the budget for as long as the session is open, so a parallel
  // session can't quietly overrun the month mid-stream.
  const budget = route.billing === 'instance' ? ai.budget() : { tokens: null, audioSeconds: null };
  if (budget.audioSeconds !== null) {
    const left = await remainingBudget(db, caller.user.id, budget);
    const remaining = left.audioSeconds ?? 0;
    if (remaining <= 0) {
      send({ type: 'error', code: 'ai_budget_exceeded' });
      await finish('budget_exceeded', 'failed');
      return;
    }
    capSeconds = Math.min(capSeconds, remaining);
  }
  // Reserve the whole session's worst case up front: that is both the budget check and the
  // guarantee a parallel session can't quietly overrun the month mid-stream.
  try {
    usageId = await reserveUsage(db, {
      userId: caller.user.id,
      credentialId: credential.id,
      billing: route.billing,
      feature: 'ramble.live',
      provider: credential.provider,
      model: route.model,
      estimate: { tokens: 0, audioSeconds: capSeconds },
      budget,
    });
  } catch (err) {
    if (err instanceof AiBudgetExceededError) {
      send({ type: 'error', code: 'ai_budget_exceeded' });
      await finish('budget_exceeded', 'failed');
      return;
    }
    throw err;
  }
  rate = provider.sampleRate;
  const ctx = await loadRambleContext(
    db,
    caller.user.id,
    deps.settings.get('instance.defaultTimezone'),
    caller.scope,
  );
  if (!sawStart) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        onStart = null;
        resolve();
      }, 500);
      onStart = () => {
        clearTimeout(timer);
        onStart = null;
        resolve();
      };
    });
  }
  if (closed) return;
  try {
    providerSocket = await connect(provider.url(credential, route.model), {
      headers: provider.headers(credential),
      policy: ai.outboundPolicy(credential.ownerUserId),
      signal: aborter.signal,
    });
  } catch {
    await finish('provider_error', 'failed');
    return;
  }
  if (closed) {
    providerSocket.close();
    return;
  }
  providerSocket.on('error', () => void finish('provider_error', 'failed'));
  providerSocket.on('close', () => void finish('provider_error', 'failed'));
  try {
    session = provider.open(
      providerSocket,
      route.model,
      ctx,
      {
        onReady: (sampleRate) => send({ type: 'ready', sampleRate }),
        onTranscript: (text, final) => send({ type: 'transcript', text, final }),
        onDraft: (update) => send({ type: 'draft', ...update }),
        onError: (code) => send({ type: 'error', code }),
      },
      startDraft,
    );
  } catch {
    await finish('provider_error', 'failed');
    return;
  }
  started = Date.now();
  for (const message of pending.splice(0)) handle(message);
  // The cap is on the session, not on the client's messages: an idle session ends too.
  timers.cap = setTimeout(() => void finish('session_too_long', 'done'), capSeconds * 1000);
  timers.revalidate = setInterval(() => {
    void (async () => {
      if (!(await caller.stillValid())) await finish('unauthorized', 'failed');
    })().catch(() => finish('unauthorized', 'failed'));
  }, RAMBLE_LIVE.revalidateMs);
}
