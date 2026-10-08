import { CSRF_HEADER, type ApiError as ApiErrorBody } from '@bokydo/shared';

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
