// @vitest-environment node
import type { Note } from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import {
  bodyLinksTask,
  isNoteGoneError,
  noteExportAvailability,
  noteExportPath,
  noteLoadPhase,
  pathFor,
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
