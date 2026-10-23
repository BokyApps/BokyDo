import { describe, expect, it } from 'vitest';
import {
  floatToPcm16,
  liveCloseText,
  liveErrorText,
  liveSocketUrl,
  parseServerMessage,
  pcmToBase64,
  resampleLinear,
} from './ramble-live.js';

describe('liveSocketUrl', () => {
  it('uses wss on https and the same origin as the page', () => {
    expect(liveSocketUrl({ protocol: 'https:', host: 'bokydo.example' })).toBe(
      'wss://bokydo.example/api/v1/ramble/live',
    );
  });

  it('uses ws on http, as in development', () => {
    expect(liveSocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/api/v1/ramble/live',
    );
  });
});

describe('PCM conversion', () => {
  it('maps the float range to signed 16-bit and clamps beyond it', () => {
    expect(Array.from(floatToPcm16(new Float32Array([0, 1, -1, 2, -2])))).toEqual([
      0, 32767, -32768, 32767, -32768,
    ]);
  });

  it('base64-encodes the little-endian PCM bytes', () => {
    // 0x0102 = 258 little-endian: 0x02 0x01.
    expect(pcmToBase64(new Int16Array([258]))).toBe('AgE=');
  });

  it('leaves audio at the wanted rate alone and resamples otherwise', () => {
    const input = new Float32Array([0, 1, 0, -1]);
    expect(resampleLinear(input, 48_000, 48_000)).toBe(input);
    const half = resampleLinear(input, 48_000, 24_000);
    expect(half.length).toBe(2);
    expect(half[0]).toBe(0);
  });
});

describe('parseServerMessage', () => {
  it('reads the frames the relay sends', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'ready', sampleRate: 24_000 }))).toEqual({
      type: 'ready',
      sampleRate: 24_000,
    });
    expect(parseServerMessage(JSON.stringify({ type: 'closed', reason: 'done' }))).toEqual({
      type: 'closed',
      reason: 'done',
    });
    expect(
      parseServerMessage(JSON.stringify({ type: 'transcript', text: 'milk', final: true })),
    ).toEqual({ type: 'transcript', text: 'milk', final: true });
  });

  it('ignores anything it does not understand', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'nope' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'ready', sampleRate: 0 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'draft', draft: [], ops: [] }))).toMatchObject(
      { type: 'draft' },
    );
    expect(parseServerMessage(JSON.stringify({ type: 'draft', draft: [] }))).toBeNull();
  });
});

describe('live messages in words', () => {
  it('explains the codes the server sends', () => {
    expect(liveErrorText('ai_budget_exceeded')).toContain('budget');
    expect(liveErrorText('unknown_code')).toBe('The live session stopped unexpectedly.');
    expect(liveCloseText('session_too_long')).toContain('time limit');
    expect(liveCloseText('done')).toBe('');
  });
});
