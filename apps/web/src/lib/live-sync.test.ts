import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchLiveChanges } from './live-sync.js';
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('pulls after reconnect and coalesces burst hints', async () => {
  const pull = vi.fn(async () => undefined);
  const invalidate = vi.fn();
  cleanup = watchLiveChanges(pull, invalidate);
  Stream.latest.dispatchEvent(new Event('open'));
  expect(pull).toHaveBeenCalledOnce();
  for (let i = 0; i < 20; i++) Stream.latest.dispatchEvent(new Event('poke'));
  await vi.advanceTimersByTimeAsync(100);
  expect(pull).toHaveBeenCalledTimes(2);
  expect(invalidate).toHaveBeenCalledTimes(2);
  Stream.latest.dispatchEvent(new Event('open'));
  expect(pull).toHaveBeenCalledTimes(3);
});
it('catches up on focus, visibility, online and periodically when streaming is unavailable', async () => {
  vi.stubGlobal('EventSource', undefined);
  const pull = vi.fn(async () => undefined);
  cleanup = watchLiveChanges(pull, vi.fn());
  window.dispatchEvent(new Event('online'));
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(pull).toHaveBeenCalledTimes(4);
});
it('closes the stream and stops pending work and listeners on unmount', async () => {
  const pull = vi.fn(async () => undefined);
  cleanup = watchLiveChanges(pull, vi.fn());
  Stream.latest.dispatchEvent(new Event('poke'));
  cleanup();
  expect(Stream.latest.close).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event('focus'));
  Stream.latest.dispatchEvent(new Event('open'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(pull).not.toHaveBeenCalled();
});
