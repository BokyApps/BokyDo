import type { ApiError as WireError, Task } from '@bokydo/shared';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import { invalidateLiveNotes, watchLiveChanges } from './live-sync.js';
import {
  addTag,
  diffNotePatch,
  normalizeTags,
  noteErrorMessage,
  searchLocalTasks,
  type NoteDraft,
} from './notes.js';
import { queryClient } from './queries.js';

const draft = (over: Partial<NoteDraft> = {}): NoteDraft => ({
  title: 'T',
  body: 'B',
  tags: ['a'],
  pinned: false,
  ...over,
});

const wireErr = (status: number, code: string, body: WireError | null = null) =>
  new ApiError(status, code, body);

describe('tag normalisation (matches the server)', () => {
  it('trims, lowercases and de-duplicates', () => {
    expect(normalizeTags(['  Work ', 'work', 'Ideas'])).toEqual(['work', 'ideas']);
  });
  it('rejects #, commas, whitespace and control characters', () => {
    expect(normalizeTags(['#tag'])).toBeNull();
    expect(normalizeTags(['a,b'])).toBeNull();
    expect(normalizeTags(['two words'])).toBeNull();
    expect(normalizeTags([`a${String.fromCharCode(1)}b`])).toBeNull();
  });
  it('rejects tags over 50 characters and more than 20 tags', () => {
    expect(normalizeTags(['x'.repeat(51)])).toBeNull();
    expect(normalizeTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toBeNull();
  });
  it('ignores empty entries', () => {
    expect(normalizeTags(['', '  ', 'ok'])).toEqual(['ok']);
  });
  it('addTag validates new input and enforces the cap', () => {
    expect(addTag(['work'], ' Ideas ')).toEqual(['work', 'ideas']);
    expect(addTag(['work'], '#bad')).toBeNull();
    expect(
      addTag(
        Array.from({ length: 20 }, (_, i) => `t${i}`),
        'one-more',
      ),
    ).toBeNull();
  });
});

describe('autosave patch diffing', () => {
  it('returns only the changed fields', () => {
    expect(diffNotePatch(draft(), draft({ title: 'T2' }))).toEqual({ title: 'T2' });
    expect(diffNotePatch(draft(), draft({ tags: ['a', 'b'], pinned: true }))).toEqual({
      tags: ['a', 'b'],
      pinned: true,
    });
  });
  it('returns null when nothing changed (value equality for tags)', () => {
    expect(diffNotePatch(draft(), draft({ tags: ['a'] }))).toBeNull();
  });
});

describe('client-side task search', () => {
  const task = (id: string, content: string, description = '', isCompleted = false) =>
    ({ id, content, description, isCompleted }) as unknown as Task;
  it('finds open tasks by content or description, case-insensitively', () => {
    const tasks = [
      task('1', 'Buy Milk'),
      task('2', 'Email Bob', 'about MILK order'),
      task('3', 'Done thing', '', true),
    ];
    expect(searchLocalTasks(tasks, 'milk').map((t) => t.id)).toEqual(['1', '2']);
  });
  it('lists open tasks when the query is empty and never returns completed tasks', () => {
    const tasks = [task('1', 'a'), task('2', 'b', '', true)];
    expect(searchLocalTasks(tasks, '   ').map((t) => t.id)).toEqual(['1']);
  });
});

describe('API error mapping', () => {
  it('shows the size limit from a too_large upload', () => {
    const err = wireErr(413, 'too_large', { error: 'too_large', maxMb: 5 } as WireError);
    expect(noteErrorMessage(err)).toContain('5 MB');
  });
  it('maps uploads_disabled, rate_limited, quota and not_found', () => {
    expect(noteErrorMessage(wireErr(403, 'uploads_disabled'))).toMatch(/turned off/);
    expect(noteErrorMessage(wireErr(429, 'rate_limited'))).toMatch(/Wait a moment/);
    expect(noteErrorMessage(wireErr(429, 'limit_exceeded'))).toMatch(/storage limit/);
    expect(noteErrorMessage(wireErr(404, 'not_found'))).toMatch(/no longer exists/);
  });
  it('falls back to the generic message', () => {
    expect(noteErrorMessage(new Error('boom'))).toMatch(/Something went wrong/);
    expect(noteErrorMessage(wireErr(400, 'validation_failed'))).toMatch(/check the form/i);
  });
});

describe('query-key invalidation on user events', () => {
  class Stream extends EventTarget {
    static latest: Stream;
    close = vi.fn();
    constructor() {
      super();
      Stream.latest = this;
    }
  }
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('EventSource', Stream);
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('invalidates the notes query key', () => {
    const qc = { invalidateQueries: vi.fn() };
    invalidateLiveNotes(qc as unknown as Pick<QueryClient, 'invalidateQueries'>);
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['notes'] });
  });

  it('refreshes notes queries on a live user-event hint', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    cleanup = watchLiveChanges(
      async () => undefined,
      () => undefined,
    );
    Stream.latest.dispatchEvent(new Event('open')); // reconnect / catch-up hint
    expect(spy).toHaveBeenCalledWith({ queryKey: ['notes'] });
  });
});
