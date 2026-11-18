// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftLeaveGuard, installDraftGuards, type DraftSaver } from './note-draft-guards.js';

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
