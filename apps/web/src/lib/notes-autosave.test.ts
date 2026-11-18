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
