// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotePatch } from '@bokydo/shared';
import { DraftLeaveGuard, installDraftGuards, type DraftSaver } from './note-draft-guards.js';
import type { NoteDraft } from './notes.js';
import { NoteAutosave } from './notes-autosave.js';

function makeSaver(over: Partial<DraftSaver> = {}): DraftSaver & {
  flush: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    hasUnsavedWork: () => true,
    keepaliveRequest: () => ({ patch: { body: 'unsaved' }, expectedUpdatedAt: 'rev-1' }),
    flush: vi.fn(async () => true),
    stop: vi.fn(),
    ...over,
  } as DraftSaver & { flush: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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
    const stop = installDraftGuards(makeSaver({ keepaliveRequest: () => null }), 'note-1');
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

describe('censor freeze: pagehide sends nothing, and a keepalive always has its premise', () => {
  const REV = '2026-11-18T10:00:00.000Z';
  const NEXT = '2026-11-18T10:00:01.000Z';
  const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';
  const base: NoteDraft = { title: 'T', body: 'B', tags: [], pinned: false };
  type SaveFn = (patch: NotePatch, expectedUpdatedAt: string) => Promise<string>;
  let save: ReturnType<typeof vi.fn<SaveFn>>;
  let autosave: NoteAutosave;

  beforeEach(() => {
    vi.useFakeTimers();
    save = vi.fn<SaveFn>(async () => NEXT);
    autosave = new NoteAutosave({ save, onStatus: vi.fn(), delayMs: 800 }, base, REV);
  });

  it('sends nothing while frozen, even though the plaintext draft is dirty', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    autosave.update({ ...base, title: 'Changed', body: 'TOPSECRET' });
    autosave.freeze();
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).not.toHaveBeenCalled();
    expect(autosave.keepaliveRequest()).toBeNull();

    const stop = installDraftGuards(autosave, 'note-1');
    window.dispatchEvent(new Event('pagehide'));
    stop();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('after cancelling, pagehide sends the PRE-censor draft with its premise', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    autosave.update({ ...base, title: 'Changed', body: 'TOPSECRET' });
    autosave.freeze();
    autosave.unfreeze();
    const stop = installDraftGuards(autosave, 'note-1');
    window.dispatchEvent(new Event('pagehide'));
    stop();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'Changed',
      body: 'TOPSECRET',
      expectedUpdatedAt: REV,
    });
  });

  it('a pending censor save is never supplemented by a keepalive', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    save.mockRejectedValueOnce(new Error('offline'));
    autosave.freeze();
    expect(await autosave.saveCensoredBody(TOKEN)).toBe('error');
    const stop = installDraftGuards(autosave, 'note-1');
    window.dispatchEvent(new Event('pagehide'));
    stop();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(autosave.keepaliveRequest()).toBeNull();
  });

  it('every keepalive request names expectedUpdatedAt (never an unguarded body)', () => {
    autosave.update({ ...base, body: TOKEN });
    const request = autosave.keepaliveRequest();
    expect(request).not.toBeNull();
    expect(request!.expectedUpdatedAt).toBe(REV);
    expect(request!.patch).toEqual({ body: TOKEN });
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
