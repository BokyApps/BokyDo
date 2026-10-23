import { z } from 'zod';
import type { Due } from './model.js';

/**
 * Ramble (PLAN §5.3): a spoken or typed brain-dump becomes a draft list of tasks. The client
 * keeps the draft; every new piece of transcript is sent with it, and the model answers with
 * edit operations (add / update / remove) that the server applies, validates and resolves
 * against what the user may write to. Nothing is created until the user commits the draft.
 */
export const RAMBLE_LIMITS = {
  /** Tasks in one draft. */
  maxDraft: 50,
  /** New transcript per extraction call (a pasted text ramble can be this long). */
  maxTextChars: 20_000,
  /** One audio chunk. */
  maxAudioBytes: 5 * 1024 * 1024,
  maxAudioSeconds: 60,
} as const;

const ref = z.string().regex(/^d[0-9]{1,3}$/, 'Draft refs look like d1, d2, …');
const name = z.string().trim().min(1).max(120);

/** A task in the draft, as the model and the review panel see it: names, not ids. */
export const rambleDraftTaskSchema = z
  .object({
    ref,
    content: z.string().trim().min(1).max(500),
    description: z.string().max(2000).optional(),
    /** Natural language, as said ("next Friday 5pm", "every Monday"); parsed by the server. */
    due: z.string().trim().min(1).max(100).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    project: name.optional(),
    section: name.optional(),
    labels: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    /** Username of a project member. */
    assignee: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
export type RambleDraftTask = z.output<typeof rambleDraftTaskSchema>;

export const rambleExtractRequestSchema = z
  .object({
    /** The new piece of transcript (a voice chunk) or the whole pasted text. */
    text: z.string().trim().min(1).max(RAMBLE_LIMITS.maxTextChars),
    draft: z.array(rambleDraftTaskSchema).max(RAMBLE_LIMITS.maxDraft).default([]),
  })
  .strict()
  .refine((r) => new Set(r.draft.map((t) => t.ref)).size === r.draft.length, 'Duplicate ref');
export type RambleExtractRequest = z.input<typeof rambleExtractRequestSchema>;

export type RambleIssue =
  'unknown_project' | 'unknown_section' | 'unknown_assignee' | 'unparsed_due' | 'new_label';

/** What a draft task would become if committed now. */
export interface RambleResolution {
  /** null: the Inbox. */
  projectId: string | null;
  sectionId: string | null;
  due: Due | null;
  labels: string[];
  assigneeId: string | null;
  issues: RambleIssue[];
}

export type RambleResolvedTask = RambleDraftTask & { resolved: RambleResolution };

export interface RambleOpSummary {
  op: 'add' | 'update' | 'remove';
  ref: string;
}

export interface RambleExtractResponse {
  draft: RambleResolvedTask[];
  /** What changed, in order (for highlighting); operations the server refused are left out. */
  ops: RambleOpSummary[];
}

/** Commit: the reviewed draft. `projectId` overrides the named project (chosen in review). */
export const rambleCommitRequestSchema = z
  .object({
    tasks: z
      .array(rambleDraftTaskSchema.extend({ projectId: z.uuid().optional() }))
      .min(1)
      .max(RAMBLE_LIMITS.maxDraft),
  })
  .strict()
  .refine((r) => new Set(r.tasks.map((t) => t.ref)).size === r.tasks.length, 'Duplicate ref');
export type RambleCommitRequest = z.input<typeof rambleCommitRequestSchema>;

export interface RambleCommitResponse {
  created: { ref: string; taskId: string }[];
}

export const rambleTranscribeQuerySchema = z
  .object({
    /** The chunk's length as recorded; metering never counts less than its size implies. */
    seconds: z.coerce.number().positive().max(RAMBLE_LIMITS.maxAudioSeconds),
    language: z
      .string()
      .regex(/^[a-z]{2,3}$/)
      .optional(),
  })
  .strict();

/**
 * Live Ramble (W8-live): a WebSocket relay for OpenAI Realtime / Gemini Live. The browser never
 * sees the provider key, only a small provider-agnostic protocol: it streams raw PCM audio and
 * control frames to the server, which holds the key, applies the same draft edit operations as
 * `/ramble/extract`, meters the audio and caps the session. The provider's own event protocol is
 * the server's business, so the client depends on no one vendor.
 */
export const RAMBLE_LIVE = {
  /** Longest one live session may run, whatever the model does. */
  maxSeconds: 600,
  /** Raw PCM16 audio a client may send in one frame (before base64). */
  maxAudioBytes: 256 * 1024,
  /** Ceiling on a client's audio over a whole session, independent of the seconds cap. */
  maxSessionAudioBytes: 32 * 1024 * 1024,
  /** Largest client frame we will parse (base64 expands by ~4/3). */
  maxMessageChars: 512 * 1024,
  /** How often a live session's login is re-checked while it is open. */
  revalidateMs: 25_000,
} as const;

const audioFrame = z
  .string()
  .min(1)
  .max(Math.ceil(RAMBLE_LIVE.maxAudioBytes * (4 / 3)) + 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Base64 audio only');

/** A control frame the browser (or an app) sends over the live socket. */
export const rambleLiveClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('audio'), data: audioFrame }).strict(),
  z
    .object({
      type: z.literal('text'),
      text: z.string().trim().min(1).max(RAMBLE_LIMITS.maxTextChars),
    })
    .strict(),
  z.object({ type: z.literal('stop') }).strict(),
]);
export type RambleLiveClientMessage = z.output<typeof rambleLiveClientMessageSchema>;

/** Why the relay ended the session. */
export type RambleLiveCloseReason =
  | 'done'
  | 'session_too_long'
  | 'too_much_audio'
  | 'budget_exceeded'
  | 'unauthorized'
  | 'not_configured'
  | 'provider_error'
  | 'client_closed';

/** Frames the server sends back. */
export interface RambleLiveReady {
  type: 'ready';
  /** Input sample rate the client must record at (Hz, mono PCM16). */
  sampleRate: number;
}
export interface RambleLiveTranscript {
  type: 'transcript';
  text: string;
  final: boolean;
}
export interface RambleLiveDraft {
  type: 'draft';
  draft: RambleResolvedTask[];
  ops: RambleOpSummary[];
}
export interface RambleLiveError {
  type: 'error';
  code: string;
}
export interface RambleLiveClosed {
  type: 'closed';
  reason: RambleLiveCloseReason;
}
export type RambleLiveServerMessage =
  RambleLiveReady | RambleLiveTranscript | RambleLiveDraft | RambleLiveError | RambleLiveClosed;
