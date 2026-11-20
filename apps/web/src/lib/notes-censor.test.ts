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
import {
  CensorFlow,
  PasswordPromptQueue,
  lockCensored,
  onCensorLock,
  type CensorPrompts,
} from './notes-censor.js';

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

  it('lockCensored clears the key cache and notifies listeners with the reason', () => {
    const listener = vi.fn();
    const off = onCensorLock(listener);
    lockCensored('manual');
    expect(mockClear).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('manual');
    off();
    lockCensored('pagehide');
    expect(listener).toHaveBeenCalledOnce(); // unsubscribed
  });
});

describe('P3: capture the lock generation before the first await', () => {
  it('censor: a lock while the password prompt is open encrypts nothing and returns null', async () => {
    const askPassword = vi.fn(async () => {
      lockCensored('pagehide');
      return 'pw';
    });
    const flow = new CensorFlow(prompts({ askPassword }), { warned: false });
    expect(await flow.onCensor('secret')).toBeNull();
    expect(mockCensor).not.toHaveBeenCalled();
  });

  it('censor: a lock while encrypting does not return a token', async () => {
    let release!: (token: string) => void;
    mockCensor.mockImplementation(() => new Promise<string>((resolve) => (release = resolve)));
    const flow = new CensorFlow(prompts(), { warned: false });
    const pending = flow.onCensor('secret');
    await flush();
    lockCensored('manual');
    release('TOKEN');
    expect(await pending).toBeNull();
  });

  it('Remove: a lock while the confirmation dialog is open stops the whole flow', async () => {
    const confirmRemove = vi.fn(async () => {
      lockCensored('signout');
      return true;
    });
    const flow = new CensorFlow(prompts({ confirmRemove }), { warned: false });
    expect(await flow.onUncensor('TOKEN')).toBeNull();
    expect(mockTryUnlock).not.toHaveBeenCalled();
    expect(mockUncensor).not.toHaveBeenCalled();
  });

  it('Reveal: a lock while the password prompt is open reveals nothing', async () => {
    const askPassword = vi.fn(async () => {
      lockCensored('hidden');
      return 'pw';
    });
    const flow = new CensorFlow(prompts({ askPassword }), { warned: false });
    expect(await flow.onReveal('TOKEN')).toBeNull();
    expect(mockUncensor).not.toHaveBeenCalled();
  });
});

describe('M2: a lock during a bad-password decrypt never reopens the prompt', () => {
  it('hides the tab while decrypting: settles as cancelled, one prompt only', async () => {
    mockUncensor.mockImplementationOnce(async () => {
      lockCensored('hidden');
      throw new CensorError('bad_password');
    });
    const askPassword = vi.fn(async () => 'pw');
    const flow = new CensorFlow(prompts({ askPassword }), { warned: false });
    expect(await flow.onReveal('TOKEN')).toBeNull();
    expect(askPassword).toHaveBeenCalledTimes(1);
    expect(mockUncensor).toHaveBeenCalledTimes(1);
  });

  it('a lock during a rejected encryption never reopens the password dialog', async () => {
    mockCensor.mockImplementationOnce(async () => {
      lockCensored('pagehide');
      throw new CensorError('empty_text');
    });
    const askPassword = vi.fn(async () => 'pw');
    const flow = new CensorFlow(prompts({ askPassword }), { warned: false });
    expect(await flow.onCensor('secret')).toBeNull();
    expect(askPassword).toHaveBeenCalledTimes(1);
  });

  it('a lock before a retry prompt stops the loop (no second decrypt)', async () => {
    mockUncensor.mockRejectedValueOnce(new CensorError('bad_password')).mockResolvedValue('plain');
    const askPassword = vi
      .fn()
      .mockResolvedValueOnce('pw')
      .mockImplementationOnce(async () => {
        lockCensored('hidden');
        return 'pw';
      });
    const flow = new CensorFlow(prompts({ askPassword }), { warned: false });
    expect(await flow.onReveal('TOKEN')).toBeNull();
    expect(askPassword).toHaveBeenCalledTimes(2);
    expect(mockUncensor).toHaveBeenCalledTimes(1);
  });
});

describe('P4: password prompts are serialised (supersede, never overwrite)', () => {
  it('a second prompt resolves the first as cancelled', async () => {
    const queue = new PasswordPromptQueue();
    const first = queue.ask();
    const second = queue.ask();
    expect(await first.promise).toBeNull();
    expect(queue.activeId).toBe(second.id);
    expect(queue.settle(first.id, 'stale')).toBe(false);
    expect(queue.settle(second.id, 'pw')).toBe(true);
    expect(await second.promise).toBe('pw');
    expect(queue.activeId).toBeNull();
  });

  it('cancelAll resolves the open prompt as cancelled; settling it later is a no-op', async () => {
    const queue = new PasswordPromptQueue();
    const prompt = queue.ask();
    queue.cancelAll();
    expect(await prompt.promise).toBeNull();
    expect(queue.settle(prompt.id, 'pw')).toBe(false);
  });
});
