import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../app.js';
import type { DbHandle } from '../db/client.js';
import { newId } from '../db/ids.js';
import { users } from '../db/schema.js';
import { ensureAppSecrets } from '../security/app-secrets.js';
import { hashPassword } from '../security/password.js';
import { freshDb } from './db.js';

export const TEST_HOST = 'bokydo.test';
export const TEST_ORIGIN = `http://${TEST_HOST}`;

export interface TestApp {
  app: FastifyInstance;
  db: DbHandle;
  close(): Promise<void>;
}

export async function testApp(
  opts: { webRoot?: string; fetchImpl?: typeof fetch } = {},
): Promise<TestApp> {
  const db = await freshDb();
  const secrets = await ensureAppSecrets(await mkdtemp(path.join(tmpdir(), 'bokydo-test-')));
  const app = await buildApp({
    db,
    secrets,
    webRoot: opts.webRoot ?? null,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return {
    app,
    db,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export async function createUser(
  db: DbHandle,
  opts: { username: string; password: string; isAdmin?: boolean; mustChangePassword?: boolean },
): Promise<string> {
  const id = newId();
  await db.db.insert(users).values({
    id,
    username: opts.username,
    passwordHash: await hashPassword(opts.password),
    isAdmin: opts.isAdmin ?? false,
    mustChangePassword: opts.mustChangePassword ?? false,
  });
  return id;
}

/** Minimal browser stand-in: cookie jar, Origin header and CSRF token handling. */
export class Client {
  cookies = new Map<string, string>();
  csrfToken: string | null = null;

  constructor(
    private readonly app: FastifyInstance,
    public origin: string | null = TEST_ORIGIN,
  ) {}

  async request(opts: InjectOptions & { csrf?: boolean }): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {
      host: TEST_HOST,
      ...(opts.headers as Record<string, string>),
    };
    if (this.origin) headers.origin ??= this.origin;
    if (this.cookies.size)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.csrfToken && opts.csrf !== false) headers['x-csrf-token'] ??= this.csrfToken;
    const res = await this.app.inject({ ...opts, headers });
    if ((opts as { payloadAsStream?: boolean }).payloadAsStream) return res;
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now()))
        this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const body = safeJson(res.body);
    if (body && typeof body.csrfToken === 'string') this.csrfToken = body.csrfToken;
    return res;
  }

  get(url: string) {
    return this.request({ method: 'GET', url });
  }
  post(url: string, payload?: unknown, opts: Partial<InjectOptions> & { csrf?: boolean } = {}) {
    return this.request({ method: 'POST', url, payload: payload as never, ...opts });
  }
  put(url: string, payload?: unknown) {
    return this.request({ method: 'PUT', url, payload: payload as never });
  }
  patch(url: string, payload?: unknown) {
    return this.request({ method: 'PATCH', url, payload: payload as never });
  }

  async login(username: string, password: string): Promise<LightMyRequestResponse> {
    return this.post('/api/v1/auth/login', { username, password });
  }
}

function safeJson(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Capture outgoing mail instead of sending it, and make email look configured. */
export async function captureMail(
  app: FastifyInstance,
): Promise<{ to: string; subject: string; text: string }[]> {
  const sent: { to: string; subject: string; text: string }[] = [];
  app.services.mailer.send = async (mail) => {
    sent.push(mail);
  };
  await app.services.settings.update(
    { 'email.smtpHost': 'smtp.test', 'email.fromAddress': 'bokydo@example.com' },
    { userId: null, ip: null },
  );
  return sent;
}

/** The token from the last emailed link (tokens travel in the URL fragment). */
export function tokenFromMail(mail: { text: string } | undefined): string {
  const match = mail?.text.match(/#([A-Za-z0-9_-]{43})/);
  if (!match) throw new Error(`no link token in mail: ${mail?.text}`);
  return match[1]!;
}
