import { beforeEach, describe, expect, it, vi } from 'vitest';

// The crypto module is the only collaborator: mock it so no real PBKDF2 runs and we can assert
// that unlocking is never triggered outside an explicit action.
vi.mock('./censor.js', () => {
  class CensorError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'CensorError';
    }
  }
  return {
    CensorError,
    censor: vi.fn(),
    uncensor: vi.fn(),
    censorKeys: {
      generation: 0,
      tryUnlock: vi.fn(),
      clear: vi.fn(),
    },
    CENSOR_PLACEHOLDER: '█████',
  };
});

import { CensorError, censor, uncensor, censorKeys } from './censor.js';
import { CensorFlow, lockCensors, onCensorLock, type CensorPrompts } from './notes-censor.js';

const mockCensor = vi.mocked(censor);
const mockUncensor = vi.mocked(uncensor);
const mockTryUnlock = vi.mocked(censorKeys.tryUnlock);
const mockClear = vi.mocked(censorKeys.clear);

function prompts(over: Partial<CensorPrompts> = {}): CensorPrompts {
  return {
    askPassword: vi.fn(async () => 'pw'),
    confirmRemove: vi.fn(async () => true),
    ...over,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetAllMocks();
  mockTryUnlock.mockResolvedValue(null);
  mockUncensor.mockResolvedValue('plain');
  mockCensor.mockResolvedValue('TOKEN');
});

describe('censor flow state machine', () => {
  it('never unlocks (or derives) without an explicit Reveal/Remove action', async () => {
    const p = prompts();
    // Constructing the flow is what happens on render: no crypto, no unlock.
    const flow = new CensorFlow(p, { warned: false });
    expect(mockTryUnlock).not.toHaveBeenCalled();
    expect(mockUncensor).not.toHaveBeenCalled();
    expect(mockCensor).not.toHaveBeenCalled();
    // Only the explicit reveal starts an unlock.
    await flow.onReveal('TOKEN');
    expect(mockTryUnlock).toHaveBeenCalledWith('TOKEN');
  });

  it('shows the unrecoverable warning only once per session', async () => {
    const p = prompts({ askPassword: vi.fn(async () => null) });
    const flow = new CensorFlow(p, { warned: false });
    await flow.onCensor('secret');
    await flow.onCensor('secret2');
    expect(p.askPassword).toHaveBeenNthCalledWith(1, { confirm: true, warning: true, error: null });
    expect(p.askPassword).toHaveBeenNthCalledWith(2, {
      confirm: true,
      warning: false,
      error: null,
    });
    expect(mockCensor).not.toHaveBeenCalled(); // both were cancelled
  });

  it('surfaces censor errors as dialog messages and re-prompts', async () => {
    mockCensor.mockRejectedValueOnce(new CensorError('empty_text')).mockResolvedValueOnce('TOKEN');
    const askPassword = vi.fn(async () => 'pw');
    const flow = new CensorFlow(prompts({ askPassword }), { warned: false });
    expect(await flow.onCensor('secret')).toBe('TOKEN');
    expect(askPassword).toHaveBeenCalledTimes(2);
    expect(askPassword).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ error: expect.stringMatching(/no text/i) }),
    );
  });

  it('reveal uses a cached key without prompting for a password', async () => {
    mockTryUnlock.mockResolvedValue('cached-plain');
    const p = prompts();
    const flow = new CensorFlow(p, { warned: false });
    expect(await flow.onReveal('TOKEN')).toBe('cached-plain');
    expect(p.askPassword).not.toHaveBeenCalled();
    expect(mockUncensor).not.toHaveBeenCalled();
  });

  it('merges concurrent unlocks for one token (<= 1 in flight)', async () => {
    let release!: (value: string) => void;
    mockUncensor.mockImplementation(() => new Promise<string>((resolve) => (release = resolve)));
    const p = prompts();
    const flow = new CensorFlow(p, { warned: false });
    const a = flow.onReveal('TOKEN');
    const b = flow.onReveal('TOKEN');
    await flush();
    expect(mockTryUnlock).toHaveBeenCalledTimes(1);
    expect(p.askPassword).toHaveBeenCalledTimes(1);
    expect(mockUncensor).toHaveBeenCalledTimes(1);
    release('plain');
    expect(await a).toBe('plain');
    expect(await b).toBe('plain');
  });

  it('closes silently when a lock voids the unlock (CensorError locked)', async () => {
    mockUncensor.mockRejectedValue(new CensorError('locked'));
    const p = prompts();
    const flow = new CensorFlow(p, { warned: false });
    expect(await flow.onReveal('TOKEN')).toBeNull();
    expect(p.askPassword).toHaveBeenCalledTimes(1); // no error re-prompt
    expect(mockUncensor).toHaveBeenCalledWith('TOKEN', 'pw', censorKeys);
  });

  it('re-prompts with an error on a bad password', async () => {
    mockUncensor
      .mockRejectedValueOnce(new CensorError('bad_password'))
      .mockResolvedValueOnce('plain');
    const p = prompts();
    const flow = new CensorFlow(p, { warned: false });
    expect(await flow.onReveal('TOKEN')).toBe('plain');
    expect(p.askPassword).toHaveBeenCalledTimes(2);
    expect(p.askPassword).toHaveBeenLastCalledWith({
      confirm: false,
      warning: false,
      error: expect.stringContaining('Wrong password'),
    });
  });

  it('Remove censor confirms before any unlock', async () => {
    const p = prompts({ confirmRemove: vi.fn(async () => false) });
    const flow = new CensorFlow(p, { warned: false });
    expect(await flow.onUncensor('TOKEN')).toBeNull();
    expect(p.confirmRemove).toHaveBeenCalled();
    expect(mockTryUnlock).not.toHaveBeenCalled();
  });

  it('Remove censor uses the same explicit unlock flow after confirmation', async () => {
    const p = prompts();
    const flow = new CensorFlow(p, { warned: false });
    expect(await flow.onUncensor('TOKEN')).toBe('plain');
    expect(mockTryUnlock).toHaveBeenCalledWith('TOKEN');
  });

  it('lockCensors clears the key cache and notifies listeners', () => {
    const listener = vi.fn();
    const off = onCensorLock(listener);
    lockCensors();
    expect(mockClear).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    off();
    lockCensors();
    expect(listener).toHaveBeenCalledOnce(); // unsubscribed
  });
});
