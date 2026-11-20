// @vitest-environment happy-dom
import type { Note } from '@bokydo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

const router = vi.hoisted(() => ({
  blocker: { status: 'idle' as 'idle' | 'blocked' },
  proceed: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useBlocker: () => ({
    status: router.blocker.status,
    proceed: router.proceed,
    reset: router.reset,
  }),
}));

vi.mock('../../lib/sync.js', () => ({
  useSyncState: () => ({ tasks: new Map(), projects: new Map(), sections: new Map() }),
}));

// The marker's own storage/digest semantics are covered by notes-censor-marker.test.ts; here the
// page only has to react to the three outcomes. Mocking the async check keeps the page test
// deterministic (real SHA-256 runs on the thread pool, not on fake timers).
const marker = vi.hoisted(() => ({
  check: vi.fn<(noteId: string, body: string) => Promise<'none' | 'saved' | 'missing'>>(),
}));
// Censoring is off in the product until its follow-up lands; these tests keep exercising the
// page's censor flow so it stays correct for that deliverable.
vi.mock('../../lib/notes.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CENSORING_ENABLED: true,
}));
vi.mock('../../lib/notes-censor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NotesCensor>();
  return { ...actual, checkPendingCensor: (id: string, body: string) => marker.check(id, body) };
});

const password = vi.hoisted(() => ({ ask: vi.fn<(opts: unknown) => Promise<string | null>>() }));
const snapshot = vi.hoisted(() => ({
  verify: vi.fn<(markdown: string) => { markdown: string; fallback: boolean; mismatch: boolean }>(),
}));
vi.mock('./PasswordDialog.js', () => ({
  usePasswordPrompt: () => ({ askPassword: password.ask, dialog: null }),
}));

// The real editor is TipTap in a lazy chunk; this stands in for the read/write contract the page
// depends on: it renders the incoming Markdown and emits edits through onChange. The two buttons
// expose the same callbacks the real editor calls, so the page's freeze/save/verify contracts can
// be driven without mounting TipTap.
vi.mock('../../components/notes/NoteEditor.js', () => ({
  default: ({
    markdown,
    onChange,
    editable,
    onCensor,
    onCensorSettled,
    onSerialized,
  }: {
    markdown: string;
    onChange: (md: string) => void;
    editable?: boolean;
    onCensor?: (markdown: string) => Promise<string | null>;
    onCensorSettled?: (outcome: string) => void;
    onSerialized?: (snapshot: {
      markdown: string;
      verified(): { markdown: string; fallback: boolean; mismatch: boolean };
    }) => void;
  }) => (
    <>
      <textarea
        aria-label="Note body"
        className="bk-note-prosemirror"
        value={markdown}
        disabled={editable === false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        data-testid="censor"
        onClick={() => {
          void onCensor?.('secret').then((token) => {
            onCensorSettled?.(token ? 'ok' : 'cancelled');
          });
        }}
      >
        Censor
      </button>
      <button
        type="button"
        data-testid="unsafe-snapshot"
        onClick={() => onSerialized?.({ markdown, verified: () => snapshot.verify(markdown) })}
      >
        unsafe snapshot
      </button>
    </>
  ),
}));

import type * as NotesCensor from '../../lib/notes-censor.js';
import { lockCensored } from '../../lib/censor-lock.js';
import { ConfirmProvider } from '../../lib/confirm.js';
import { notesKeys, noteFocusSurface } from '../../lib/notes.js';
import { censorTokenDigest } from '../../lib/notes-censor.js';
import { ToastProvider } from '../../lib/toasts.js';
import { NoteDetail } from './NoteDetail.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const R1 = '2026-11-18T10:00:00.000Z';
const R2 = '2026-11-18T10:00:01.000Z';
const R3 = '2026-11-18T10:00:02.000Z';
const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';

function makeNote(over: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    title: 'T',
    body: 'B',
    snippet: 'B',
    tags: ['tag'],
    state: 'active',
    pinned: false,
    createdAt: R1,
    updatedAt: R1,
    trashedAt: null,
    backlinks: [],
    linkedTasks: [],
    files: [],
    ...over,
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const staleBody = (updatedAt: string) => json({ error: 'stale_revision', updatedAt }, 409);

/** The note a successful PATCH answers with, given the guard and the fields it wrote. */
function savedFrom(patch: Record<string, unknown>, updatedAt: string): Note {
  return makeNote({
    title: typeof patch.title === 'string' ? patch.title : 'T',
    body: typeof patch.body === 'string' ? patch.body : 'B',
    tags: Array.isArray(patch.tags) ? (patch.tags as string[]) : ['tag'],
    pinned: typeof patch.pinned === 'boolean' ? patch.pinned : false,
    updatedAt,
  });
}

let client: QueryClient;
let container: HTMLDivElement;
let root: Root;
let unmounted: boolean;
let patchCalls: Record<string, unknown>[];
let patchHandler: (body: Record<string, unknown>) => Response | Promise<Response>;
let getNote: () => Note;
let getFails: boolean;
let getGone: boolean;

function tree(): ReactNode {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ConfirmProvider>
          <NoteDetail noteId="note-1" />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(5);
  });

async function render(): Promise<void> {
  await act(async () => root.render(tree()));
  await settle();
  await settle();
}

/** Simulate a live user-event hint: the open note query refetches the newest server version. */
async function refetch(): Promise<void> {
  await act(async () => {
    await client.invalidateQueries({ queryKey: notesKeys.detail('note-1') });
  });
  await settle();
}

function body(): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note body"]');
  if (!el) throw new Error('editor not rendered');
  return el;
}

function title(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input[aria-label="Note title"]');
  if (!el) throw new Error('title not rendered');
  return el;
}

function banner(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[aria-live="assertive"]');
}

async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    setValue?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
}

async function click(label: string): Promise<void> {
  const button = buttonByText(label);
  if (!button) throw new Error(`no "${label}" button in: ${container.textContent ?? ''}`);
  await act(async () => {
    button.click();
    await vi.advanceTimersByTimeAsync(5);
  });
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  patchCalls = [];
  patchHandler = (patch) => json({ note: savedFrom(patch, R2) });
  getNote = () => makeNote();
  getFails = false;
  getGone = false;
  router.blocker.status = 'idle';
  router.proceed.mockClear();
  router.reset.mockClear();
  marker.check.mockReset();
  marker.check.mockResolvedValue('none');
  password.ask.mockReset();
  password.ask.mockResolvedValue(null);
  snapshot.verify.mockReset();
  snapshot.verify.mockImplementation((markdown) => ({
    markdown,
    fallback: true,
    mismatch: true,
  }));
  unmounted = false;
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchCalls.push(patch);
        return patchHandler(patch);
      }
      if (url.startsWith('/api/v1/notes/') && (!init?.method || init.method === 'GET')) {
        if (getGone) return json({ error: 'not_found' }, 404);
        if (getFails) return json({ error: 'error' }, 500);
        return json({ note: getNote() });
      }
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.useFakeTimers();
});

afterEach(() => {
  if (!unmounted) act(() => root.unmount());
  container.remove();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('every note save is guarded by the revision it was based on', () => {
  it('sends expectedUpdatedAt on each PATCH and advances it from the answer', async () => {
    await render();
    await type(body(), 'B2');
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(patchCalls).toEqual([{ body: 'B2', expectedUpdatedAt: R1 }]);

    // The first answer (R2) is the premise of the next save.
    await type(body(), 'B3');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[1]).toEqual({ body: 'B3', expectedUpdatedAt: R2 });
  });
});

describe('409 stale_revision', () => {
  it('adopts the remote note silently when the draft has nothing unsaved', async () => {
    let respond!: (response: Response) => void;
    patchHandler = () => new Promise<Response>((resolve) => (respond = resolve));

    await render();
    // The other tab saves after this one loaded the note.
    getNote = () => makeNote({ title: 'Theirs', body: 'Their body', updatedAt: R2 });
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(patchCalls).toHaveLength(1);

    await type(body(), 'B'); // undone before the answer arrives: no unsaved work left
    respond(staleBody(R2));
    await settle();
    await settle();

    expect(banner()).toBeNull();
    expect(body().value).toBe('Their body');
    expect(title().value).toBe('Theirs');
    expect(patchCalls).toHaveLength(1); // no retry, no adoption save
  });

  it('pauses on a dirty draft, then Keep mine resends the whole draft on the new revision', async () => {
    patchHandler = () => staleBody(R2);

    await render();
    getNote = () => makeNote({ title: 'Theirs', body: 'Their body', updatedAt: R2 });
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();
    expect(banner()).not.toBeNull();
    expect(banner()?.textContent).toContain('This note changed elsewhere');
    expect(body().value).toBe('Mine');

    // Paused: edits do not send anything until the user chooses.
    await type(body(), 'Mine 2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(patchCalls).toHaveLength(1);

    patchHandler = (patch) => json({ note: savedFrom(patch, R3) });
    await click('Keep mine');
    await settle();

    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[1]).toEqual({
      title: 'T',
      body: 'Mine 2',
      tags: ['tag'],
      pinned: false,
      expectedUpdatedAt: R2,
    });
    expect(banner()).toBeNull();
    expect(body().value).toBe('Mine 2');
  });

  it('asks before bringing back text censored elsewhere, focusing the safe choice', async () => {
    patchHandler = () => staleBody(R2);

    await render();
    getNote = () => makeNote({ body: `before ${TOKEN} after`, updatedAt: R2 });
    await type(body(), 'plaintext again');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();
    expect(banner()?.textContent).toContain('This note changed elsewhere');

    await click('Keep mine');
    expect(patchCalls).toHaveLength(1); // nothing is sent before the confirmation
    const warning = banner();
    expect(warning?.textContent).toContain('bring back text that was censored elsewhere');
    expect(document.activeElement?.textContent?.trim()).toBe('Load their version');

    patchHandler = (patch) => json({ note: savedFrom(patch, R3) });
    await click('Keep mine anyway');
    await settle();
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[1]).toMatchObject({
      body: 'plaintext again',
      expectedUpdatedAt: R2,
    });
  });

  it('Load their version discards the draft', async () => {
    patchHandler = () => staleBody(R2);
    getNote = () => makeNote({ title: 'Theirs', body: 'Their body', updatedAt: R2 });

    await render();
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();
    await click('Load their version');
    await settle();

    expect(body().value).toBe('Their body');
    expect(title().value).toBe('Theirs');
    expect(banner()).toBeNull();
    expect(patchCalls).toHaveLength(1);
  });
});

describe('P5: linked-task provenance comes from the server', () => {
  it('uses the sources array instead of reading note bodies', async () => {
    getNote = () =>
      makeNote({
        linkedTasks: [
          {
            id: 't-body',
            content: 'Body task',
            projectId: 'p',
            completed: false,
            sources: ['body'],
          },
          {
            id: 't-manual',
            content: 'Manual task',
            projectId: 'p',
            completed: false,
            sources: ['manual'],
          },
          {
            id: 't-both',
            content: 'Both task',
            projectId: 'p',
            completed: false,
            sources: ['body', 'manual'],
          },
        ],
      });
    await render();
    expect(container.textContent).toContain('Linked in the note text');
    expect(container.textContent).toContain('Linked manually');
    // Only the two tasks with a manual link offer Unlink; body-only links cannot be unlinked here.
    expect(container.querySelectorAll('button[aria-label="Unlink task"]')).toHaveLength(2);
    // No per-note detail request was made (the fetch mock would throw for one).
    expect(patchCalls).toHaveLength(0);
  });
});

describe('MED: conflict recovery when the saved version cannot be fetched', () => {
  it('shows Retry fetch instead of a version choice, and Load theirs never falls back', async () => {
    patchHandler = () => staleBody(R2);
    await render();
    getNote = () => makeNote({ body: 'Their body', updatedAt: R2 });
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();
    expect(banner()).not.toBeNull();

    getFails = true;
    await click('Load their version');
    await settle();
    expect(body().value).toBe('Mine'); // never adopts the cached conflict snapshot
    expect(banner()?.textContent).toContain("couldn't be fetched");
    expect(buttonByText('Retry fetch')).toBeTruthy();
    expect(buttonByText('Load their version')).toBeUndefined();

    getFails = false;
    getNote = () => makeNote({ body: 'Their newest', updatedAt: R3 });
    await click('Retry fetch');
    await settle();
    // Fetching works again: the normal choice is back and the draft is untouched.
    expect(banner()?.textContent).toContain('This note changed elsewhere');
    expect(body().value).toBe('Mine');

    await click('Load their version');
    await settle();
    expect(body().value).toBe('Their newest');
    expect(banner()).toBeNull();
  });

  it('a note deleted between the 409 and the reload takes the deleted path', async () => {
    patchHandler = () => staleBody(R2);
    await render();
    getNote = () => makeNote({ body: 'Their body', updatedAt: R2 });
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();
    expect(banner()).not.toBeNull();

    getGone = true;
    await click('Load their version');
    await settle();
    expect(banner()).toBeNull();
    expect(container.textContent).toContain('This note was deleted');
    expect(body().disabled).toBe(true);
    expect(patchCalls).toHaveLength(1); // the deleted path never resends the draft
  });

  it('the leave dialog offers Resolve conflict instead of a blind retry after a 409', async () => {
    patchHandler = () => staleBody(R2);
    await render();
    getNote = () => makeNote({ body: 'Their body', updatedAt: R2 });
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();

    // A navigation hit the conflict while flushing: the router blocks and opens the leave dialog.
    router.blocker.status = 'blocked';
    await type(title(), 'T2');
    expect(buttonByText('Resolve conflict')).toBeTruthy();
    expect(buttonByText('Try again')).toBeUndefined();

    await click('Resolve conflict');
    expect(router.reset).toHaveBeenCalledOnce();
    expect(banner()?.textContent).toContain('This note changed elsewhere');
    expect(patchCalls).toHaveLength(1); // resolving does not resend anything
  });
});

describe('MED: the censor warning is lenient', () => {
  it('asks before keeping a draft over a saved body that merely looks censored', async () => {
    patchHandler = () => staleBody(R2);
    await render();
    getNote = () => makeNote({ body: 'a {{ censored: hand-written b', updatedAt: R2 });
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();

    await click('Keep mine');
    expect(patchCalls).toHaveLength(1); // nothing is sent before the confirmation
    expect(banner()?.textContent).toContain('This would bring back censored text');
  });
});

describe('MED 2c: a censor marker warns on the next visit', () => {
  it('warns when the saved body lacks the token this tab censored', async () => {
    marker.check.mockResolvedValue('missing');
    await render();
    await settle();
    expect(container.textContent).toContain('Your last censor may not have been saved');
  });

  it('stays quiet when the token reached the server', async () => {
    marker.check.mockResolvedValue('saved');
    await render();
    await settle();
    expect(container.textContent).not.toContain('Your last censor may not have been saved');
  });

  it('clears the marker when a save acknowledges the token body', async () => {
    await render(); // the open check runs with no marker
    sessionStorage.setItem(
      'bokydo:note-censor-pending:note-1',
      JSON.stringify({ noteId: 'note-1', tokenDigest: await censorTokenDigest(TOKEN) }),
    );

    // The editor hands over the token document after a censor: this is its save.
    await type(body(), TOKEN);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(patchCalls).toEqual([{ body: TOKEN, expectedUpdatedAt: R1 }]);
    expect(sessionStorage.getItem('bokydo:note-censor-pending:note-1')).toBeNull();
  });
});

describe('MED: the censor marker is checked against a fresh server body', () => {
  it('warns when a cached body still has the token but the fresh GET does not', async () => {
    // The cache (and the initially rendered note) still carries the token; the server no longer
    // does. Comparing cached data would wrongly say the censor was saved.
    client.setQueryData(notesKeys.detail('note-1'), makeNote({ body: `before ${TOKEN} after` }));
    getNote = () => makeNote({ body: 'plaintext came back' });
    marker.check.mockImplementation(async (_id, body) =>
      body.includes(TOKEN) ? 'saved' : 'missing',
    );

    await render();
    await settle();
    expect(marker.check).toHaveBeenCalled();
    expect(marker.check.mock.calls[0]?.[1]).toBe('plaintext came back');
    expect(container.textContent).toContain('Your last censor may not have been saved');
  });
});

describe('verification blocks an unsafe body but keeps other fields saving', () => {
  it('shows the explicit error, never sends the body, and saves the title', async () => {
    await render();
    await type(body(), 'Mine');
    // Register the verifier snapshot for the exact Markdown the editor emitted.
    await click('unsafe snapshot');
    await type(title(), 'T2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toEqual({ title: 'T2', expectedUpdatedAt: R1 });
    expect(body().value).toBe('Mine');
    expect(container.textContent).toContain(
      "This note couldn't be saved safely — please copy your text and report it",
    );
  });

  it('keeps the verifier attached for the unmount flush', async () => {
    await render();
    await type(body(), 'Mine');
    await click('unsafe snapshot');
    snapshot.verify.mockImplementation((markdown) => ({
      markdown,
      fallback: false,
      mismatch: false,
    }));

    await act(async () => {
      unmounted = true;
      root.unmount();
    });
    await vi.advanceTimersByTimeAsync(5);

    expect(snapshot.verify).toHaveBeenCalledWith('Mine');
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toEqual({ body: 'Mine', expectedUpdatedAt: R1 });
  });
});

describe('censor freeze cancels with the pre-censor draft', () => {
  it('a lock while the password prompt is open unfreezes every field', async () => {
    let resolveAsk!: (value: string | null) => void;
    password.ask.mockImplementation(
      () => new Promise<string | null>((resolve) => (resolveAsk = resolve)),
    );

    await render();
    await click('Censor');
    expect(password.ask).toHaveBeenCalledOnce();
    expect(title().disabled).toBe(true);
    expect(body().disabled).toBe(true);

    // Automatic cancel: a hidden tab / pagehide / lock all reach the same censor lock listener.
    await act(async () => {
      lockCensored('hidden');
    });
    await act(async () => {
      resolveAsk(null);
      await vi.advanceTimersByTimeAsync(5);
    });

    expect(title().disabled).toBe(false);
    expect(body().disabled).toBe(false);
    // The pre-censor draft is intact and normal autosave resumes.
    expect(body().value).toBe('B');
  });
});

describe('LOW: focus after a conflict resolution', () => {
  it('prefers the visible Markdown source textarea when that view is open', () => {
    const holder = document.createElement('div');
    const prose = document.createElement('div');
    prose.className = 'bk-note-prosemirror';
    const source = document.createElement('textarea');
    source.className = 'bk-note-textarea';
    holder.append(prose, source);
    expect(noteFocusSurface(holder)).toBe(source);
    source.remove();
    expect(noteFocusSurface(holder)).toBe(prose);
  });

  it('returns focus to the editor after Load their version', async () => {
    patchHandler = () => staleBody(R2);
    await render();
    getNote = () => makeNote({ body: 'Their body', updatedAt: R2 });
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();

    await click('Load their version');
    await settle();
    expect(document.activeElement).toBe(body());
  });

  it('returns focus to the editor after Keep mine', async () => {
    patchHandler = () => staleBody(R2);
    await render();
    getNote = () => makeNote({ body: 'Their body', updatedAt: R2 });
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();

    patchHandler = (patch) => json({ note: savedFrom(patch, R3) });
    await click('Keep mine');
    await settle();
    expect(document.activeElement).toBe(body());
  });
});

describe('MED: live sync during an in-flight save', () => {
  it('keeps the newest snapshot and adopts it once the queue is idle', async () => {
    let respond!: (response: Response) => void;
    patchHandler = () => new Promise<Response>((resolve) => (respond = resolve));

    await render();
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(patchCalls).toHaveLength(1);

    // A live hint brings a newer revision while this tab's older PATCH is still in flight.
    getNote = () => makeNote({ body: 'Remote newer', updatedAt: R3 });
    await refetch();
    expect(body().value).toBe('Mine'); // the draft stays while saving

    // The older PATCH answers at R2: it must not replace the R3 now in the cache.
    respond(json({ note: savedFrom({ body: 'Mine' }, R2) }));
    await settle();
    await settle();

    expect(client.getQueryData<Note>(notesKeys.detail('note-1'))?.updatedAt).toBe(R3);
    expect(body().value).toBe('Remote newer');
    expect(patchCalls).toHaveLength(1); // adopting the server note never saves
  });
});

describe('live sync adoption', () => {
  it('adopts a refetched note while the draft is clean', async () => {
    await render();
    expect(body().value).toBe('B');

    getNote = () => makeNote({ title: 'Remote title', body: 'Remote body', updatedAt: R2 });
    await refetch();

    expect(body().value).toBe('Remote body');
    expect(title().value).toBe('Remote title');
    expect(patchCalls).toHaveLength(0);
  });

  it('keeps a dirty draft, whose next save then hits the conflict path', async () => {
    await render();
    await type(body(), 'Mine');
    await settle();

    getNote = () => makeNote({ body: 'Remote body', updatedAt: R2 });
    await refetch();
    expect(body().value).toBe('Mine'); // a live change never clobbers unsaved work

    patchHandler = () => staleBody(R3);
    getNote = () => makeNote({ body: 'Remote body 2', updatedAt: R3 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toEqual({ body: 'Mine', expectedUpdatedAt: R1 });
    expect(banner()).not.toBeNull();
    expect(body().value).toBe('Mine');
  });
});
