// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { RevealController, installRevealDismissal } from './reveal-controller.js';

const ANCHOR = { top: 0, left: 0, bottom: 0, right: 0 };

describe('P4: a reveal does not survive losing the window', () => {
  it('closes a mounted overlay on window blur', async () => {
    const controller = new RevealController(async () => 'SECRET');
    const stop = installRevealDismissal(controller);
    await controller.request('TOKEN', ANCHOR);
    expect(controller.current?.plaintext).toBe('SECRET');
    window.dispatchEvent(new Event('blur'));
    expect(controller.current).toBeNull();
    stop();
  });

  it('discards an unlock still in flight when the page is hidden', async () => {
    let release!: (value: string | null) => void;
    const pending = new Promise<string | null>((resolve) => (release = resolve));
    const controller = new RevealController(() => pending);
    const stop = installRevealDismissal(controller);
    const request = controller.request('TOKEN', ANCHOR);
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    release('SECRET');
    await request;
    expect(controller.current).toBeNull();
    stop();
  });

  it('teardown removes both listeners', async () => {
    const controller = new RevealController(async () => 'SECRET');
    const stop = installRevealDismissal(controller);
    stop();
    await controller.request('TOKEN', ANCHOR);
    window.dispatchEvent(new Event('blur'));
    expect(controller.current?.plaintext).toBe('SECRET');
  });
});
