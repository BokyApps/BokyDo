// @vitest-environment happy-dom
import type { NotePatch } from '@bokydo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftLeaveGuard, installDraftGuards, type DraftSaver } from './note-draft-guards.js';
import type { NoteDraft } from './notes.js';
import { NoteAutosave } from './notes-autosave.js';

function makeSaver(over: Partial<DraftSaver> = {}): DraftSaver & {
  flush: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    hasUnsavedWork: () => true,
    pendingPatch: () => ({ body: 'unsaved' }),
    baseRevision: () => 'rev-1',
    flush: vi.fn(async () => true),
    stop: vi.fn(),
    ...over,
  } as DraftSaver & { flush: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P2: beforeunload / pagehide guards', () => {
  it('prompts on beforeunload only while there is unsaved work', () => {
    const dirty = makeSaver();
    const stop = installDraftGuards(dirty, 'note-1');
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    stop();

    const clean = makeSaver({ hasUnsavedWork: () => false });
    const stopClean = installDraftGuards(clean, 'note-1');
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
    stopClean();
  });

  it('sends a keepalive PATCH with the latest patch and its revision', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const stop = installDraftGuards(makeSaver(), 'note-1');
    window.dispatchEvent(new Event('pagehide'));
    stop();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/notes/note-1');
    expect(init?.method).toBe('PATCH');
    expect(init?.keepalive).toBe(true);
    expect(JSON.parse(String(init?.body))).toEqual({
      body: 'unsaved',
      expectedUpdatedAt: 'rev-1',
    });
  });

  it('sends nothing when everything is acknowledged', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const stop = installDraftGuards(makeSaver({ pendingPatch: () => null }), 'note-1');
    window.dispatchEvent(new Event('pagehide'));
    stop();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('teardown removes both listeners', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const stop = installDraftGuards(makeSaver(), 'note-1');
    stop();
    window.dispatchEvent(new Event('pagehide'));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('H2: pagehide during a censor prompt never sends the plaintext body', () => {
  const REV = '2026-11-18T10:00:00.000Z';
  const NEXT = '2026-11-18T10:00:01.000Z';
  const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';
  const base: NoteDraft = { title: 'T', body: 'B', tags: [], pinned: false };
  type SaveFn = (patch: NotePatch, revision: string) => Promise<string>;
  let save: ReturnType<typeof vi.fn<SaveFn>>;
  let autosave: NoteAutosave;

  beforeEach(() => {
    vi.useFakeTimers();
    save = vi.fn<SaveFn>(async () => NEXT);
    autosave = new NoteAutosave({ save, onStatus: vi.fn(), delayMs: 800 }, base, REV);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function keepaliveBody(fetchMock: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/v1/notes/note-1');
    expect(init.keepalive).toBe(true);
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('sends other fields but omits body while paused', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    autosave.update({ ...base, title: 'Changed', body: 'TOPSECRET' });
    autosave.pauseBody(); // opened the password prompt
    const stop = installDraftGuards(autosave, 'note-1');
    window.dispatchEvent(new Event('pagehide'));
    stop();
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = keepaliveBody(fetchMock);
    expect(body.title).toBe('Changed');
    expect(body).not.toHaveProperty('body');
    expect(JSON.stringify(body)).not.toContain('TOPSECRET');
  });

  it('sends nothing when only the paused body changed', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    autosave.update({ ...base, body: 'TOPSECRET' });
    autosave.pauseBody();
    const stop = installDraftGuards(autosave, 'note-1');
    window.dispatchEvent(new Event('pagehide'));
    stop();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the body held after a successful censor until the token draft arrives', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    autosave.update({ ...base, title: 'Changed', body: 'TOPSECRET' });
    autosave.pauseBody();
    autosave.flushNextUpdate(); // a token was produced; the editor has not applied it yet
    const stop = installDraftGuards(autosave, 'note-1');
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(keepaliveBody(fetchMock)).not.toHaveProperty('body');

    // The verified token document reaches autosave: it saves immediately, without the debounce.
    autosave.update({ ...base, title: 'Changed', body: TOKEN });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledWith({ title: 'Changed', body: TOKEN }, REV);
    stop();
  });
});

describe('P2: the router blocker flushes before allowing a leave', () => {
  it('allows the navigation when the flush acknowledged everything', async () => {
    const saver = makeSaver();
    expect(await new DraftLeaveGuard(saver).shouldBlock()).toBe(false);
    expect(saver.flush).toHaveBeenCalledOnce();
  });

  it('blocks the navigation when the save failed (draft stays with Retry)', async () => {
    const saver = makeSaver({ flush: vi.fn(async () => false) });
    expect(await new DraftLeaveGuard(saver).shouldBlock()).toBe(true);
  });

  it('does not flush when there is nothing to lose', async () => {
    const saver = makeSaver({ hasUnsavedWork: () => false });
    expect(await new DraftLeaveGuard(saver).shouldBlock()).toBe(false);
    expect(saver.flush).not.toHaveBeenCalled();
  });

  it('discard stops the controller and lets the navigation proceed', () => {
    const saver = makeSaver();
    new DraftLeaveGuard(saver).discard();
    expect(saver.stop).toHaveBeenCalledOnce();
  });
});
