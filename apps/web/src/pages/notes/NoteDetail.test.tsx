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

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ status: 'idle', proceed: vi.fn(), reset: vi.fn() }),
}));

vi.mock('../../lib/sync.js', () => ({
  useSyncState: () => ({ tasks: new Map(), projects: new Map(), sections: new Map() }),
}));

vi.mock('./PasswordDialog.js', () => ({
  usePasswordPrompt: () => ({ askPassword: async () => null, dialog: null }),
}));

// The real editor is TipTap in a lazy chunk; this stands in for the read/write contract the page
// depends on: it renders the incoming Markdown and emits edits through onChange.
vi.mock('../../components/notes/NoteEditor.js', () => ({
  default: ({
    markdown,
    onChange,
    editable,
  }: {
    markdown: string;
    onChange: (md: string) => void;
    editable?: boolean;
  }) => (
    <textarea
      aria-label="Note body"
      value={markdown}
      disabled={editable === false}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { ConfirmProvider } from '../../lib/confirm.js';
import { notesKeys } from '../../lib/notes.js';
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
let patchCalls: Record<string, unknown>[];
let patchHandler: (body: Record<string, unknown>) => Response | Promise<Response>;
let getNote: () => Note;
let writeText: ReturnType<typeof vi.fn>;

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

async function click(label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
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
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
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
  act(() => root.unmount());
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

  it('Copy mine copies the draft Markdown, then loads theirs', async () => {
    patchHandler = () => staleBody(R2);

    await render();
    getNote = () => makeNote({ body: 'Their body', updatedAt: R2 });
    await type(body(), 'Mine');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await settle();
    await click('Copy mine');
    await settle();

    expect(writeText).toHaveBeenCalledWith('Mine');
    expect(body().value).toBe('Their body');
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
