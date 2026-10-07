# ADR 0007: AI provider adapters — chat, streaming, structured replies, speech and embeddings

- Status: Accepted (2026-10-07)

## Context

W7a (ADR 0006) built the core: the SSRF-safe outbound client, encrypted credentials, routing and
metered budgets. Nothing could call a model yet. W8 (Ramble) and W9 (assist, reports, "ask your
tasks", decisions) need chat with tool calls and JSON replies, streamed text, speech to text and
embeddings, against every provider in the catalog, without each feature re-learning three wire
formats or how to meter them.

## Decision

- **Adapters per dialect, not per vendor.** The catalog already says which dialect a provider
  speaks: `openai` (OpenAI, xAI, Groq, OpenRouter, Ollama, Ollama Cloud, custom), `anthropic`
  (Anthropic, custom) or `gemini`. `apps/server/src/ai/chat.ts` maps one neutral request
  (system prompt, user/assistant/tool messages, tools, tool choice, JSON schema, output limit)
  to each dialect and back to one result (text, tool calls, why it stopped, usage). OpenAI's own
  API gets `max_completion_tokens`; compatible servers get `max_tokens`. Temperature is only
  sent when a feature asks, since several reasoning models refuse it.
- **Structured replies** use each dialect's strongest mechanism: a JSON schema response format
  (OpenAI; falling back to plain JSON mode with the schema in the prompt when a compatible
  server rejects schemas), a forced tool call (Anthropic) or `responseJsonSchema` (Gemini).
  `AiService.chatJson` validates the reply with the feature's zod schema, gives the model one
  correction round with the validation issues, and otherwise fails with `output_invalid`. The
  schema proves shape only: features still check what a reply refers to (W8/W9 gates).
- **Streaming** is opt-in (`onText`). Server-sent events are parsed by hand (CR/LF handling,
  events split across packets, 1 MiB per event) inside the outbound client's size and time
  limits. Tool-call arguments stream in pieces and are only parsed at the end; arguments that
  aren't valid JSON come back as `undefined` for the caller's validation to reject.
- **Retries** live in the transport (`transport.ts`): 408/429/5xx/529 and dropped connections,
  three attempts, backoff from 0.5 s with jitter, `Retry-After` honoured up to 20 s (a longer
  wait fails as `rate_limited`). Policy refusals (blocked address, redirect, plain http) and
  timeouts are never retried, and nothing is retried once a successful response is being read.
  All attempts sit inside the call's single budget reservation.
- **Errors are codes.** A failed call is an `AiProviderError` with a code, the HTTP status and
  what it consumed; the provider's response body is discarded unread, because error bodies echo
  requests and sometimes keys. Mid-stream failures keep the usage reported so far.
- **Metering.** `AiService.chat`, `chatJson`, `transcribe` and `embed` reserve a worst case
  (prompt characters ÷ 2 plus the output limit, doubled for `chatJson`'s correction round;
  audio seconds; embedding characters ÷ 2) and settle to the provider's reported usage, or an
  estimate (characters ÷ 4) when it reports none. A feature can only make calls of its own
  capability: the speech route can't be used to chat.
- **Speech to text** posts multipart form data to OpenAI-style `/audio/transcriptions` (OpenAI,
  Groq, custom Whisper servers) with a random boundary, an allow-listed audio type and size
  (25 MiB), and is metered by the duration the provider reports, else the caller's.
- **Embeddings** cover the OpenAI dialect (including Ollama) and Gemini's batch endpoint;
  vectors are reordered by their index and must be complete, finite and of equal length.
- **Model names in URLs** (Gemini puts the model in the path) are percent-encoded, so a model
  name can't select a different endpoint.
- **"Try this model"** (`POST …/credentials/:id/try`, user and admin variants) makes a real,
  tiny chat, transcription (one second of silence) or embedding call with a stored credential,
  so the settings UI can check a route before saving it. It shares the "test connection" rate
  limit (10 a minute), returns codes and latency only, and isn't metered.

## Consequences

- W8 and W9 build on `ai.chat` / `ai.chatJson` / `ai.transcribe` / `ai.embed` and never see a
  credential, URL or wire format.
- Live audio (OpenAI Realtime, Gemini Live) is not covered: it needs WebSockets, which the
  outbound client doesn't speak. It moves to W8 together with the live pipeline.
- Providers that report no usage are metered by estimate, so instance budgets for them are
  approximate.
- The 2-characters-per-token reservation over-reserves English text about twofold. That only
  matters close to a budget's limit, and the reservation is settled straight after the call.
