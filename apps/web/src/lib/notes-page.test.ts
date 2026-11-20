// @vitest-environment node
import type { Note } from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import {
  bodyLinksTask,
  censorConflictWarning,
  censorTokensIn,
  isNoteGoneError,
  isStaleRevisionError,
  keepMineAllowed,
  newestNote,
  noteExportAvailability,
  noteExportPath,
  noteLoadPhase,
  pathFor,
  prepareNoteSavePatch,
} from './notes.js';

const TASK = '123e4567-e89b-12d3-a456-426614174000';
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('P2: a background refetch error keeps a ready note mounted', () => {
  it('ready wins over an error when data is already present', () => {
    expect(noteLoadPhase({ isPending: false, isError: true, data: {} as Note })).toBe('ready');
  });

  it('shows the error page only when there is nothing to render', () => {
    expect(noteLoadPhase({ isPending: false, isError: true, data: undefined })).toBe('error');
    expect(noteLoadPhase({ isPending: true, isError: false, data: undefined })).toBe('loading');
    expect(noteLoadPhase({ isPending: false, isError: false, data: undefined })).toBe('loading');
  });
});

describe('P2: only a 404 means the note is gone', () => {
  it('recognises the deleted-note response and nothing else', () => {
    expect(isNoteGoneError(new ApiError(404, 'not_found', null))).toBe(true);
    expect(isNoteGoneError(new ApiError(500, 'error', null))).toBe(false);
    expect(isNoteGoneError(new Error('network'))).toBe(false);
  });
});

describe('stale revisions', () => {
  const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';

  it('recognises only a 409 stale_revision as a conflict', () => {
    expect(isStaleRevisionError(new ApiError(409, 'stale_revision', null))).toBe(true);
    expect(isStaleRevisionError(new ApiError(409, 'id_conflict', null))).toBe(false);
    expect(isStaleRevisionError(new ApiError(404, 'not_found', null))).toBe(false);
    expect(isStaleRevisionError(new Error('stale_revision'))).toBe(false);
  });

  it('finds censor tokens case-insensitively by prefix, exactly by token', () => {
    expect(censorTokensIn(`a ${TOKEN} b`)).toEqual([TOKEN]);
    expect(censorTokensIn('{{CENSORED:v1:abc:def:ghi}}')).toEqual(['{{CENSORED:v1:abc:def:ghi}}']);
    expect(censorTokensIn('{{censored: broken')).toEqual([]);
    expect(censorTokensIn('no tokens here')).toEqual([]);
  });

  it('requires a confirmation whenever a differing saved body looks censor-like', () => {
    expect(censorConflictWarning(`before ${TOKEN} after`, 'before plaintext after')).toBe(true);
    // MED: lenient — any `{{censored` spelling counts, even one the strict parser rejects.
    expect(censorConflictWarning('a {{ censored: hand-written b', 'a plaintext b')).toBe(true);
    expect(censorConflictWarning('a {{CENSORED:v1:ZZZ:YYY:XXX}} b', 'a plaintext b')).toBe(true);
    // Identical bodies mean Keep mine restores nothing.
    expect(censorConflictWarning(`a ${TOKEN} b`, `a ${TOKEN} b`)).toBe(false);
    expect(censorConflictWarning('plain', `a ${TOKEN} b`)).toBe(false);
    expect(censorConflictWarning('', 'plain')).toBe(false);
  });
});

describe('MED: the newest server snapshot wins in the cache', () => {
  const note = (updatedAt: string, body: string): Note =>
    ({
      id: 'n',
      title: 'T',
      body,
      snippet: body,
      tags: [],
      state: 'active',
      pinned: false,
      createdAt: '2026-11-18T09:00:00.000Z',
      updatedAt,
      trashedAt: null,
      backlinks: [],
      linkedTasks: [],
      files: [],
    }) satisfies Note;
  const R2 = '2026-11-18T10:00:01.000Z';
  const R3 = '2026-11-18T10:00:02.000Z';

  it('keeps a newer cached note over an older PATCH answer', () => {
    const cached = note(R3, 'newer');
    expect(newestNote(cached, note(R2, 'older'))).toBe(cached);
    expect(newestNote(undefined, note(R2, 'first'))).toEqual(note(R2, 'first'));
    // An answer at the same revision (or newer) is accepted.
    const saved = note(R3, 'saved');
    expect(newestNote(cached, saved)).toBe(saved);
  });
});

describe('P1: export links wait for acknowledgement', () => {
  it('has no href while the controller is dirty or saving', () => {
    expect(noteExportAvailability('id', 'md', { dirty: true, saving: false })).toEqual({
      href: null,
      disabled: true,
    });
    expect(noteExportAvailability('id', 'pdf', { dirty: false, saving: true })).toEqual({
      href: null,
      disabled: true,
    });
    expect(noteExportAvailability('id', 'docx', { dirty: true, saving: true })).toEqual({
      href: null,
      disabled: true,
    });
  });

  it('offers the real export path once everything is acknowledged', () => {
    expect(noteExportAvailability('id', 'md', { dirty: false, saving: false })).toEqual({
      href: noteExportPath('id', 'md'),
      disabled: false,
    });
  });

  it('is unavailable while the censor freeze owns the save', () => {
    expect(
      noteExportAvailability('id', 'md', { dirty: false, saving: false, frozen: true }),
    ).toEqual({ href: null, disabled: true });
  });
});

describe('final review: safe conflict and save decisions', () => {
  const note = (over: Partial<Note> = {}): Note => ({
    id: 'n',
    title: 'T',
    body: 'B',
    snippet: 'B',
    tags: [],
    state: 'active',
    pinned: false,
    createdAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:01.000Z',
    trashedAt: null,
    backlinks: [],
    linkedTasks: [],
    files: [],
    ...over,
  });

  it('Keep mine needs a fetched remote and a revision-bound censor confirmation', () => {
    expect(keepMineAllowed(null, 'mine', null)).toBe(false);
    const plain = note({ body: 'theirs' });
    expect(keepMineAllowed(plain, 'mine', null)).toBe(true);
    const censored = note({ body: 'a {{censored:v1:x:y:z}} b' });
    expect(keepMineAllowed(censored, 'mine', null)).toBe(false);
    expect(keepMineAllowed(censored, 'mine', censored.updatedAt)).toBe(true);
    expect(keepMineAllowed(censored, 'mine', 'another-revision')).toBe(false);
  });

  it('a serializer mismatch drops only the body and keeps the rest of the patch', () => {
    const snapshot = (mismatch: boolean) => ({
      markdown: 'mine',
      verified: () => ({ markdown: 'mine', fallback: true, mismatch }),
    });
    expect(prepareNoteSavePatch({ body: 'mine', title: 'T2' }, snapshot(true))).toEqual({
      patch: { title: 'T2' },
      bodyUnsafe: true,
    });
    expect(prepareNoteSavePatch({ body: 'mine' }, snapshot(true))).toEqual({
      patch: null,
      bodyUnsafe: true,
    });
    expect(prepareNoteSavePatch({ body: 'mine', title: 'T2' }, snapshot(false))).toEqual({
      patch: { body: 'mine', title: 'T2' },
      bodyUnsafe: false,
    });
  });

  it('source-view edits save as typed (no matching editor snapshot)', () => {
    expect(
      prepareNoteSavePatch(
        { body: 'typed by hand' },
        {
          markdown: 'editor markdown',
          verified: () => ({ markdown: 'x', fallback: false, mismatch: true }),
        },
      ),
    ).toEqual({ patch: { body: 'typed by hand' }, bodyUnsafe: false });
  });
});

describe('P5: provenance is derived from the note body', () => {
  it('finds a body link to the task', () => {
    expect(bodyLinksTask(`see [the task](bokydo:task/${TASK}) here`, TASK)).toBe(true);
    expect(bodyLinksTask(`[t](bokydo:task/${TASK} "Title")`, TASK)).toBe(true);
    expect(bodyLinksTask(`[t](BOKYDO:TASK/${TASK.toUpperCase()})`, TASK)).toBe(true);
  });

  it('never mistakes another task, prose or a code sample for a link', () => {
    expect(bodyLinksTask(`[t](bokydo:task/${OTHER})`, TASK)).toBe(false);
    expect(bodyLinksTask(`bokydo:task/${TASK}`, TASK)).toBe(false);
    expect(bodyLinksTask('```\n[t](bokydo:task/' + TASK + ')\n```', TASK)).toBe(false);
    expect(bodyLinksTask('`[t](bokydo:task/' + TASK + ')`', TASK)).toBe(false);
  });

  it('handles several links and a missing task id', () => {
    const body = `[a](bokydo:note/${OTHER}) [b](bokydo:task/${TASK})`;
    expect(bodyLinksTask(body, TASK)).toBe(true);
    expect(bodyLinksTask(body, OTHER)).toBe(false);
  });
});

describe('paths', () => {
  it('encodes the note id exactly once', () => {
    expect(pathFor('a b')).toBe('/api/v1/notes/a%20b');
  });
});
