// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { RevealController } from './reveal-controller.js';

const ANCHOR = { top: 0, left: 0, bottom: 0, right: 0 };

describe('RevealController (page-owned lifecycle / CONTRACT CHANGE)', () => {
  it('does not unlock until an explicit Reveal action', () => {
    const unlock = vi.fn(async () => 'SECRET');
    const controller = new RevealController(unlock);
    expect(unlock).not.toHaveBeenCalled();
    expect(controller.current).toBeNull();
  });

  it('delivers plaintext via subscribe and never returns it to the caller', async () => {
    const controller = new RevealController(async () => 'SECRET');
    const seen: (string | null)[] = [];
    controller.subscribe((state) => seen.push(state?.plaintext ?? null));
    const result = await controller.request('TOKEN', ANCHOR);
    expect(result).toBeUndefined(); // fire-and-forget: no plaintext to the editor
    expect(controller.current?.plaintext).toBe('SECRET');
    expect(controller.current?.anchor).toEqual(ANCHOR);
    expect(seen).toContain('SECRET');
  });

  it('discards a late reveal after close (request-id invalidation)', async () => {
    let release!: (value: string | null) => void;
    const pending = new Promise<string | null>((resolve) => (release = resolve));
    const controller = new RevealController(() => pending);
    const request = controller.request('TOKEN', ANCHOR);
    controller.close(); // Escape / blur / lock while the unlock is still in flight
    release('SECRET');
    await request;
    expect(controller.current).toBeNull(); // late result never mounted
  });

  it('a lock/close voids an already-mounted overlay', async () => {
    const controller = new RevealController(async () => 'SECRET');
    await controller.request('TOKEN', ANCHOR);
    expect(controller.current?.plaintext).toBe('SECRET');
    controller.close();
    expect(controller.current).toBeNull();
  });

  it('a newer Reveal supersedes an older pending unlock', async () => {
    const resolvers: (() => void)[] = [];
    const unlock = (token: string) =>
      new Promise<string>((resolve) => {
        resolvers.push(() => resolve(`plain-for-${token}`));
      });
    const controller = new RevealController(unlock);
    const first = controller.request('A', ANCHOR);
    const second = controller.request('B', ANCHOR);
    resolvers[0]!();
    await first;
    expect(controller.current).toBeNull(); // first result discarded
    resolvers[1]!();
    await second;
    expect(controller.current?.plaintext).toBe('plain-for-B');
  });

  it('a null unlock result (cancel / wrong password) mounts nothing', async () => {
    const controller = new RevealController(async () => null);
    await controller.request('TOKEN', ANCHOR);
    expect(controller.current).toBeNull();
  });
});
