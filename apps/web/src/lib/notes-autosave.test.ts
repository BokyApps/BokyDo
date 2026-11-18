import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import type { NoteDraft } from './notes.js';
import { NoteAutosave } from './notes-autosave.js';

const REV = '2026-11-18T10:00:00.000Z';
const NEXT = '2026-11-18T10:00:01.000Z';
const REMOTE = '2026-11-18T10:00:02.000Z';
const KEPT = '2026-11-18T10:00:03.000Z';

const stale = new ApiError(409, 'stale_revision', { error: 'stale_revision' });

const draft = (over: Partial<NoteDraft> = {}): NoteDraft => ({
  title: 'T',
  body: 'B',
  tags: ['a'],
  pinned: false,
  ...over,
});

function setup() {
  const save = vi.fn(async () => NEXT);
  const onStatus = vi.fn();
  const onError = vi.fn();
  const onConflict = vi.fn();
  const controller = new NoteAutosave(
    { save, onStatus, onError, onConflict, delayMs: 800 },
    draft(),
    REV,
  );
  return { save, onStatus, onError, onConflict, controller };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('autosave debounce / diff / flush', () => {
  it('PATCHes only the changed fields after the debounce, with the base revision', async () => {
    const { save, controller } = setup();
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: 'T2' }, REV);
  });

  it('debounces a burst of edits into one save of the latest draft', async () => {
    const { save, controller } = setup();
    controller.update(draft({ title: 'T1' }));
    await vi.advanceTimersByTimeAsync(300);
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(300);
    controller.update(draft({ title: 'T3' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: 'T3' }, REV);
  });

  it('reports saving -> saved', async () => {
    const { onStatus, controller } = setup();
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(['saving', 'saved']);
  });

  it('flush saves pending edits immediately, before the timer fires', async () => {
    const { save, controller } = setup();
    controller.update(draft({ body: 'B2' }));
    await controller.flush();
    expect(save).toHaveBeenCalledWith({ body: 'B2' }, REV);
    await vi.advanceTimersByTimeAsync(1600);
    expect(save).toHaveBeenCalledTimes(1); // the flushed save is not repeated
  });

  it('does not save when the draft returns to the saved baseline', async () => {
    const { save, controller } = setup();
    controller.update(draft({ title: 'T2' }));
    controller.update(draft()); // undo before the timer fires
    await vi.advanceTimersByTimeAsync(1600);
    expect(save).not.toHaveBeenCalled();
  });

  it('advances the baseline and the revision after a save', async () => {
    const { save, controller } = setup();
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(controller.baseRevision()).toBe(NEXT);
    controller.update(draft({ title: 'T2', body: 'B2' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ body: 'B2' }, NEXT);
  });

  it('reports an error and keeps the baseline when a save fails', async () => {
    const save = vi.fn(async () => {
      throw new Error('network');
    });
    const onStatus = vi.fn();
    const onError = vi.fn();
    const controller = new NoteAutosave({ save, onStatus, onError, delayMs: 800 }, draft(), REV);
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(onStatus).toHaveBeenLastCalledWith('error');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reset discards local drift (conflict reconciliation)', async () => {
    const { save, controller } = setup();
    controller.update(draft({ title: 'T2' }));
    controller.reset(draft({ title: 'Server', tags: [] }), REMOTE);
    await vi.advanceTimersByTimeAsync(1600);
    expect(save).not.toHaveBeenCalled();
    expect(controller.baseRevision()).toBe(REMOTE);
  });

  it('stop prevents further saves (404: note gone)', async () => {
    const { save, controller } = setup();
    controller.stop();
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(1600);
    expect(save).not.toHaveBeenCalled();
  });
});

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';

describe('P1: the censor prompt pauses the body autosave', () => {
  it('never PATCHes the plaintext: pause cancels the debounce, the token flush is immediate', async () => {
    const { save, controller } = setup();
    controller.update(draft({ body: 'TOPSECRET' }));
    await vi.advanceTimersByTimeAsync(300); // still inside the debounce window
    controller.pauseBody(); // page.onCensor: synchronously BEFORE the password prompt
    await vi.advanceTimersByTimeAsync(2000); // the user takes 2 s to type the password
    expect(save).not.toHaveBeenCalled();

    controller.flushNextUpdate(); // censor succeeded: the next revision is urgent
    controller.resumeBody();
    controller.update(draft({ body: TOKEN })); // the editor applied the token
    await vi.advanceTimersByTimeAsync(0); // no debounce: saved on the next turn
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ body: TOKEN }, REV);
    expect(JSON.stringify(save.mock.calls)).not.toContain('TOPSECRET');
  });

  it('a cancelled prompt resumes normally and saves the (unchanged) draft', async () => {
    const { save, controller } = setup();
    controller.update(draft({ body: 'still plain' }));
    controller.pauseBody();
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).not.toHaveBeenCalled();
    controller.resumeBody();
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledWith({ body: 'still plain' }, REV);
  });

  it('isDirty/pendingPatch reflect the unsaved draft', () => {
    const { controller } = setup();
    expect(controller.isDirty()).toBe(false);
    controller.update(draft({ body: 'B2' }));
    expect(controller.isDirty()).toBe(true);
    expect(controller.pendingPatch()).toEqual({ body: 'B2' });
    expect(controller.hasUnsavedWork()).toBe(true);
  });
});

describe('P2: flush drains (in-flight save, then the latest patch)', () => {
  it('waits for the save in flight and sends the newest draft before resolving', async () => {
    const resolvers: ((revision: string) => void)[] = [];
    const save = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const onStatus = vi.fn();
    const controller = new NoteAutosave({ save, onStatus, delayMs: 800 }, draft(), REV);

    controller.update(draft({ body: 'B1' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({ body: 'B1' }, REV);

    controller.update(draft({ body: 'B2' }));
    let settled = false;
    const flushed = controller.flush().then((ok) => {
      settled = ok;
      return ok;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1); // still waiting for B1
    expect(settled).toBe(false);

    resolvers[0]!(NEXT);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ body: 'B2' }, NEXT);
    expect(settled).toBe(false); // B2 is not acknowledged yet

    resolvers[1]!(REMOTE);
    expect(await flushed).toBe(true);
    expect(controller.isDirty()).toBe(false);
    expect(controller.baseRevision()).toBe(REMOTE);
  });

  it('resolves false on failure and keeps the draft dirty', async () => {
    const save = vi.fn(async () => {
      throw new Error('network');
    });
    const onStatus = vi.fn();
    const onError = vi.fn();
    const controller = new NoteAutosave({ save, onStatus, onError, delayMs: 800 }, draft(), REV);
    controller.update(draft({ body: 'B2' }));
    expect(await controller.flush()).toBe(false);
    expect(controller.isDirty()).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('resolves true without a request when nothing changed', async () => {
    const { save, controller } = setup();
    expect(await controller.flush()).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('stale revisions (optimistic concurrency)', () => {
  it('stops sending on 409 stale_revision and reports a conflict once', async () => {
    const { save, onStatus, onError, onConflict, controller } = setup();
    save.mockRejectedValueOnce(stale);
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(800);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: 'T2' }, REV);
    expect(onConflict).toHaveBeenCalledWith(stale);
    expect(onError).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith('conflict');
    expect(controller.isConflicted()).toBe(true);

    controller.update(draft({ title: 'T3' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1); // paused: the next save waits for the user's choice

    expect(await controller.flush()).toBe(false);
    expect(save).toHaveBeenCalledTimes(1); // a flush does not loop on a conflict
    expect(controller.isDirty()).toBe(true);
    expect(controller.pendingPatch()).toEqual({ title: 'T3' });
  });

  it('a flush that gets 409 fails once, keeps the draft and does not loop', async () => {
    const save = vi.fn(async () => {
      throw stale;
    });
    const onConflict = vi.fn();
    const controller = new NoteAutosave(
      { save, onStatus: vi.fn(), onConflict, delayMs: 800 },
      draft(),
      REV,
    );
    controller.update(draft({ title: 'T2' }));
    expect(await controller.flush()).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledOnce();
    expect(controller.isConflicted()).toBe(true);
    expect(controller.isDirty()).toBe(true);
  });

  it('is still clean when the edit was undone while its save was in flight', async () => {
    let rejectStale!: (err: unknown) => void;
    const save = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectStale = reject;
        }),
    );
    const onConflict = vi.fn();
    const controller = new NoteAutosave(
      { save, onStatus: vi.fn(), onConflict, delayMs: 800 },
      draft(),
      REV,
    );
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(800);
    controller.update(draft()); // back to the initial state before the answer arrives
    rejectStale(stale);
    await vi.advanceTimersByTimeAsync(0);

    expect(onConflict).toHaveBeenCalledOnce();
    expect(controller.isDirty()).toBe(false); // the page can adopt the remote note silently
    expect(controller.isConflicted()).toBe(true);
  });

  it('keepMine resends the whole draft with the remote revision as its premise', async () => {
    const { save, controller } = setup();
    save.mockRejectedValueOnce(stale);
    controller.update(draft({ title: 'Mine', pinned: true }));
    await vi.advanceTimersByTimeAsync(800);
    expect(controller.isConflicted()).toBe(true);

    save.mockResolvedValueOnce(KEPT);
    expect(await controller.keepMine(REMOTE)).toBe(true);
    expect(save).toHaveBeenLastCalledWith(
      { title: 'Mine', body: 'B', tags: ['a'], pinned: true },
      REMOTE,
    );
    expect(controller.isConflicted()).toBe(false);
    expect(controller.isDirty()).toBe(false);
    expect(controller.baseRevision()).toBe(KEPT);
  });

  it('keepMine keeps the draft when the server is stale again', async () => {
    const { save, controller } = setup();
    save.mockRejectedValueOnce(stale);
    controller.update(draft({ title: 'Mine' }));
    await vi.advanceTimersByTimeAsync(800);
    save.mockRejectedValueOnce(stale);
    expect(await controller.keepMine(REMOTE)).toBe(false);
    expect(controller.isConflicted()).toBe(true);
    expect(controller.isDirty()).toBe(true);
  });

  it('reset after a conflict resumes with the adopted revision', async () => {
    const { save, controller } = setup();
    save.mockRejectedValueOnce(stale);
    controller.update(draft({ title: 'Mine' }));
    await vi.advanceTimersByTimeAsync(800);
    controller.reset(draft({ title: 'Theirs' }), REMOTE);
    expect(controller.isConflicted()).toBe(false);
    expect(controller.isDirty()).toBe(false);
    controller.update(draft({ title: 'Next' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenLastCalledWith({ title: 'Next' }, REMOTE);
  });
});
