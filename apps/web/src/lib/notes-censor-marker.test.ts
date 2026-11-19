// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acknowledgePendingCensor,
  censorTokenDigest,
  checkPendingCensor,
  clearPendingCensor,
  markPendingCensor,
  readPendingCensor,
} from './notes-censor.js';

const NOTE = 'note-1';
const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';
const OTHER =
  '{{censored:v1:ZZZZZZZZZZZZZZZZZZZZZZ:ZZZZZZZZZZZZZZZZ:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ}}';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

beforeEach(() => {
  sessionStorage.clear();
});

describe('MED 2c: the censor save marker', () => {
  it('stores only the note id and a SHA-256 digest of the token', async () => {
    await markPendingCensor(NOTE, TOKEN);
    expect(readPendingCensor(NOTE)).toEqual({ noteId: NOTE, tokenDigest: sha256(TOKEN) });
    const raw = sessionStorage.getItem('bokydo:note-censor-pending:note-1') ?? '';
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain('censored');
    expect(raw).toContain(sha256(TOKEN));
    expect(await censorTokenDigest(TOKEN)).toBe(sha256(TOKEN));
  });

  it('clears on an acknowledgement that carries the token', async () => {
    await markPendingCensor(NOTE, TOKEN);
    expect(await acknowledgePendingCensor(NOTE, `before ${OTHER} and ${TOKEN} after`)).toBe(true);
    expect(readPendingCensor(NOTE)).toBeNull();
  });

  it('an older save answering first does not clear it', async () => {
    await markPendingCensor(NOTE, TOKEN);
    expect(await acknowledgePendingCensor(NOTE, `before ${OTHER} after`)).toBe(false);
    expect(readPendingCensor(NOTE)).not.toBeNull();
  });

  it('acknowledging without a marker is a no-op', async () => {
    expect(await acknowledgePendingCensor(NOTE, `a ${TOKEN} b`)).toBe(false);
  });

  it('opening the note warns only when the token is missing, clearing the marker either way', async () => {
    await markPendingCensor(NOTE, TOKEN);
    expect(await checkPendingCensor(NOTE, `a ${TOKEN} b`)).toBe('saved');
    expect(readPendingCensor(NOTE)).toBeNull();

    await markPendingCensor(NOTE, TOKEN);
    expect(await checkPendingCensor(NOTE, 'plaintext came back')).toBe('missing');
    expect(readPendingCensor(NOTE)).toBeNull();

    expect(await checkPendingCensor(NOTE, 'plaintext')).toBe('none');
  });

  it('a marker for another note does not leak into this one', async () => {
    await markPendingCensor('note-2', TOKEN);
    expect(readPendingCensor(NOTE)).toBeNull();
    expect(await checkPendingCensor(NOTE, 'plaintext')).toBe('none');
    expect(readPendingCensor('note-2')).not.toBeNull();
    clearPendingCensor('note-2');
  });

  it('ignores a malformed stored value', () => {
    sessionStorage.setItem('bokydo:note-censor-pending:note-1', '{"noteId":"note-1"}');
    expect(readPendingCensor(NOTE)).toBeNull();
  });
});
