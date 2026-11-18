import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteDraft } from './notes.js';
import { NoteAutosave } from './notes-autosave.js';

const draft = (over: Partial<NoteDraft> = {}): NoteDraft => ({
  title: 'T',
  body: 'B',
  tags: ['a'],
  pinned: false,
  ...over,
});

function setup() {
  const save = vi.fn(async () => undefined);
  const onStatus = vi.fn();
  const onError = vi.fn();
  const controller = new NoteAutosave({ save, onStatus, onError, delayMs: 800 }, draft());
  return { save, onStatus, onError, controller };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('autosave debounce / diff / flush', () => {
  it('PATCHes only the changed fields after the debounce', async () => {
    const { save, controller } = setup();
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: 'T2' });
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
    expect(save).toHaveBeenCalledWith({ title: 'T3' });
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
    expect(save).toHaveBeenCalledWith({ body: 'B2' });
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

  it('advances the baseline after a save, so later edits diff against it', async () => {
    const { save, controller } = setup();
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(800);
    controller.update(draft({ title: 'T2', body: 'B2' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ body: 'B2' });
  });

  it('reports an error and keeps the baseline when a save fails', async () => {
    const save = vi.fn(async () => {
      throw new Error('network');
    });
    const onStatus = vi.fn();
    const onError = vi.fn();
    const controller = new NoteAutosave({ save, onStatus, onError, delayMs: 800 }, draft());
    controller.update(draft({ title: 'T2' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(onStatus).toHaveBeenLastCalledWith('error');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reset discards local drift (conflict reconciliation)', async () => {
    const { save, controller } = setup();
    controller.update(draft({ title: 'T2' }));
    controller.reset(draft({ title: 'Server', tags: [] }));
    await vi.advanceTimersByTimeAsync(1600);
    expect(save).not.toHaveBeenCalled();
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
    expect(save).toHaveBeenCalledWith({ body: TOKEN });
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
    expect(save).toHaveBeenCalledWith({ body: 'still plain' });
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
    const resolvers: (() => void)[] = [];
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const onStatus = vi.fn();
    const controller = new NoteAutosave({ save, onStatus, delayMs: 800 }, draft());

    controller.update(draft({ body: 'B1' }));
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({ body: 'B1' });

    controller.update(draft({ body: 'B2' }));
    let settled = false;
    const flushed = controller.flush().then((ok) => {
      settled = ok;
      return ok;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1); // still waiting for B1
    expect(settled).toBe(false);

    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ body: 'B2' });
    expect(settled).toBe(false); // B2 is not acknowledged yet

    resolvers[1]!();
    expect(await flushed).toBe(true);
    expect(controller.isDirty()).toBe(false);
  });

  it('resolves false on failure and keeps the draft dirty', async () => {
    const save = vi.fn(async () => {
      throw new Error('network');
    });
    const onStatus = vi.fn();
    const onError = vi.fn();
    const controller = new NoteAutosave({ save, onStatus, onError, delayMs: 800 }, draft());
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
