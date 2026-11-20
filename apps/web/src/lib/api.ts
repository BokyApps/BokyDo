import { CSRF_HEADER, type ApiError as ApiErrorBody, type NotePatch } from '@bokydo/shared';

let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: ApiErrorBody | null,
  ) {
    super(code);
  }
}

/**
 * JSON fetch against the BokyDo API. Remembers the session's CSRF token from any response that
 * carries one and sends it on every state-changing request. The browser adds the Origin header.
 */
export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = data as ApiErrorBody | null;
    throw new ApiError(res.status, err?.error ?? 'error', err);
  }
  if (data && typeof (data as { csrfToken?: unknown }).csrfToken === 'string') {
    csrfToken = (data as { csrfToken: string }).csrfToken;
  }
  return data as T;
}

/**
 * A PATCH that survives the page going away (`pagehide`). `keepalive` lets the browser finish the
 * request after the document is gone; the CSRF header is the same one `api` sends. The revision
 * premise is ALWAYS part of the body, exactly as for an ordinary save: a stale tab must not
 * overwrite a newer save (including restoring plaintext another tab censored). A censor freeze
 * sends no keepalive at all; there is no unguarded variant. Errors are ignored by design: there is
 * no UI left to report them to.
 */
export function keepalivePatch(path: string, patch: NotePatch, expectedUpdatedAt: string): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrfToken) headers[CSRF_HEADER] = csrfToken;
  void fetch(path, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ ...patch, expectedUpdatedAt }),
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => undefined);
}

/** POST a raw body with its own content type; the CSRF header and error type are as in `api`. */
async function sendRaw<T>(path: string, body: Blob, headers: Record<string, string>): Promise<T> {
  if (csrfToken) headers[CSRF_HEADER] = csrfToken;
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body,
    credentials: 'same-origin',
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data as ApiErrorBody | null;
    throw new ApiError(res.status, err?.error ?? 'error', err);
  }
  return data as T;
}

/** Upload a file as raw bytes (it streams to disk on the server; no multipart). */
export function uploadFile<T>(path: string, file: File): Promise<T> {
  return sendRaw<T>(path, file, {
    'content-type': 'application/octet-stream',
    'x-filename': encodeURIComponent(file.name),
  });
}

/** POST one audio chunk (raw `audio/*` body, not JSON) and parse the JSON answer. */
export function postRaw<T>(path: string, body: Blob, contentType: string): Promise<T> {
  return sendRaw<T>(path, body, { 'content-type': contentType });
}

export function clearCsrfToken(): void {
  csrfToken = null;
}
