import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';
import { enablePush, pushState } from './push.js';

vi.mock('./api.js', () => ({ api: vi.fn() }));
const key = new Uint8Array([1, 2, 3]);
const subscription = {
  options: { applicationServerKey: key.buffer },
  unsubscribe: vi.fn(async () => true),
  toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fixture', keys: {} }),
};
const manager = {
  getSubscription: vi.fn(async (): Promise<typeof subscription | null> => null),
  subscribe: vi.fn(async () => subscription),
};
const registration = { pushManager: manager };
const workers = {
  register: vi.fn(async () => registration),
  ready: Promise.resolve(registration),
  getRegistration: vi.fn(async () => registration),
};
const notifications = {
  permission: 'granted',
  requestPermission: vi.fn(async () => notifications.permission),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('navigator', { serviceWorker: workers });
  vi.stubGlobal('window', { isSecureContext: true, PushManager: {}, Notification: {} });
  vi.stubGlobal('Notification', notifications);
  notifications.permission = 'granted';
  notifications.requestPermission.mockImplementation(async () => notifications.permission);
  workers.register.mockResolvedValue(registration);
  workers.getRegistration.mockResolvedValue(registration);
  manager.getSubscription.mockResolvedValue(null);
  manager.subscribe.mockResolvedValue(subscription);
  subscription.unsubscribe.mockResolvedValue(true);
  vi.mocked(api).mockImplementation(async (_method, path) =>
    path.endsWith('/key') ? { publicKey: 'AQID' } : undefined,
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('browser push setup', () => {
  it('saves a browser subscription before reporting on', async () => {
    expect(await enablePush()).toBe('on');
    expect(manager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    expect(api).toHaveBeenLastCalledWith(
      'POST',
      '/api/v1/push/subscriptions',
      subscription.toJSON(),
    );
  });

  it('reports a Brave-style push-service failure separately and allows retry', async () => {
    manager.subscribe.mockRejectedValueOnce(
      new DOMException('Registration failed - push service error', 'AbortError'),
    );
    await expect(enablePush()).rejects.toMatchObject({ problem: 'browser' });
    expect(api).not.toHaveBeenCalledWith('POST', '/api/v1/push/subscriptions', expect.anything());
    expect(await enablePush()).toBe('on');
  });

  it('keeps dismissed permission retryable rather than claiming the site is blocked', async () => {
    notifications.permission = 'default';
    await expect(enablePush()).rejects.toMatchObject({ problem: 'dismissed' });
    expect(workers.register).not.toHaveBeenCalled();
    notifications.permission = 'granted';
    expect(await enablePush()).toBe('on');
  });

  it('reports an actual permission denial without contacting the push service', async () => {
    notifications.permission = 'denied';
    expect(await enablePush()).toBe('denied');
    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it('keeps service-worker failures separate from browser and server registration', async () => {
    workers.register.mockRejectedValueOnce(new DOMException('Storage blocked', 'SecurityError'));
    await expect(enablePush()).rejects.toMatchObject({ problem: 'worker' });
    expect(manager.subscribe).not.toHaveBeenCalled();
  });

  it('does not blame browser push settings when the server key cannot be loaded', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('Offline'));
    await expect(enablePush()).rejects.toMatchObject({ problem: 'server' });
    expect(manager.subscribe).not.toHaveBeenCalled();
  });

  it('does not report success if BokyDo cannot save the subscription; retry reuses it', async () => {
    vi.mocked(api)
      .mockImplementationOnce(async () => ({ publicKey: 'AQID' }))
      .mockRejectedValueOnce(new Error('Offline'));
    await expect(enablePush()).rejects.toMatchObject({ problem: 'server' });
    manager.getSubscription.mockResolvedValue(subscription);
    expect(await enablePush()).toBe('on');
    expect(manager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('renews a subscription when the instance key changes', async () => {
    const old = {
      ...subscription,
      options: { applicationServerKey: new Uint8Array([4, 5, 6]).buffer },
    };
    manager.getSubscription.mockResolvedValue(old);
    expect(await enablePush()).toBe('on');
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(manager.subscribe).toHaveBeenCalledOnce();
  });

  it('classifies push-state inspection failures so Settings can recover', async () => {
    manager.getSubscription.mockRejectedValueOnce(
      new DOMException('Push service disabled', 'AbortError'),
    );
    await expect(pushState()).rejects.toMatchObject({ problem: 'browser' });
    expect(await pushState()).toBe('off');
  });

  it('preserves unsupported/insecure and granted subscription state', async () => {
    manager.getSubscription.mockResolvedValue(subscription);
    expect(await pushState()).toBe('on');
    vi.stubGlobal('window', { isSecureContext: false, PushManager: {}, Notification: {} });
    expect(await enablePush()).toBe('insecure');
    vi.stubGlobal('window', {});
    expect(await enablePush()).toBe('unsupported');
  });
});
