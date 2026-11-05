/** End-to-end live changes and local notifications on a fresh loopback instance. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const drivers = createRequire(import.meta.url)('playwright-core');
const base = process.env.BOKYDO_TEST_BASE_URL;
assert(
  base && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname),
  'Use a fresh loopback instance',
);
const kind = process.env.BOKYDO_TEST_BROWSER ?? 'chromium';
const browser = await drivers[kind].launch({
  executablePath: process.env.BOKYDO_BROWSER_EXECUTABLE,
  headless: true,
  ...(kind === 'chromium' ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}),
});
let debugPage;
try {
  const context = await browser.newContext({
    permissions: ['notifications'],
    timezoneId: 'UTC',
    serviceWorkers: 'allow',
  });
  context.setDefaultTimeout(15000);
  const notifications = [];
  const errors = [];
  let pushRequests = 0;
  await context.exposeBinding('recordDesktopNotice', (_source, notice) => {
    notifications.push(notice);
  });
  await context.addInitScript(() => {
    const NativeNotification = globalThis.Notification;
    globalThis.Notification = class {
      static get permission() {
        return NativeNotification.permission;
      }
      static requestPermission() {
        return NativeNotification.requestPermission();
      }
      constructor(title, options) {
        this.data = options.data;
        void globalThis.recordDesktopNotice({ title, options });
      }
      close() {}
    };
    // Catch persistent local display too; no OS notifications or browser push service are used.
    if (globalThis.ServiceWorkerRegistration)
      globalThis.ServiceWorkerRegistration.prototype.showNotification = async function (
        title,
        options,
      ) {
        await globalThis.recordDesktopNotice({ title, options });
      };
    if (globalThis.PushManager)
      globalThis.PushManager.prototype.subscribe = async () => {
        throw new DOMException('Google push service disabled', 'AbortError');
      };
  });
  context.on('page', (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
  });
  context.on('request', (request) => {
    if (/\/api\/v1\/push\/(key|subscriptions)$/.test(new URL(request.url()).pathname))
      pushRequests++;
  });
  const api = context.request;
  assert(
    (await (await api.get(`${base}/api/v1/instance`)).json()).initialAdminRequired,
    'Refusing initialized instance',
  );
  const signup = await api.post(`${base}/api/v1/setup/admin`, {
    headers: { origin: base },
    data: { username: 'live-fixture', password: 'violin-pancake-orbit-meadow' },
  });
  assert.equal(signup.status(), 201);
  const headers = { origin: base, 'x-csrf-token': (await signup.json()).csrfToken };
  assert(
    (await api.put(`${base}/api/v1/setup/public-url`, { headers, data: { publicUrl: base } })).ok(),
  );
  assert((await api.post(`${base}/api/v1/setup/complete`, { headers })).ok());
  const writer = await context.newPage();
  const observer = await context.newPage();
  await writer.goto(`${base}/settings/notifications`);
  const local = writer
    .getByRole('heading', { name: 'While BokyDo is open', exact: true })
    .locator('..');
  await local.getByRole('button', { name: 'Turn on on this device', exact: true }).click();
  await local
    .getByText('Desktop notifications are on for this device and account.', { exact: true })
    .waitFor();
  assert.equal(pushRequests, 0, 'Google-free setup never calls push endpoints');
  await observer.goto(`${base}/inbox`);
  await observer.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  const created = await api.post(`${base}/api/v1/account/tokens`, {
    headers,
    data: { name: 'Live integration fixture', scopes: ['sync'], expiresInDays: 1 },
  });
  assert.equal(created.status(), 201);
  const token = (await created.json()).token;
  // Security notice from token creation is a real synced server notification.
  await writer.waitForFunction(() =>
    [...globalThis.document.querySelectorAll('button')].some((b) =>
      b.getAttribute('aria-label')?.includes('unread'),
    ),
  );
  await writer.waitForFunction(() => globalThis.localStorage.length > 0);
  // Wait for a single display across both tabs, then an extra sync must not replay it.
  await observer.waitForFunction(() => globalThis.Notification.permission === 'granted');
  for (let i = 0; i < 100 && notifications.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(notifications.length, 1, 'Exactly one new notice across open tabs');
  const beforeBurst = notifications.length;
  const burst = await Promise.all(
    ['Burst one', 'Burst two'].map((name) =>
      api.post(`${base}/api/v1/account/tokens`, {
        headers,
        data: { name, scopes: ['tasks:read'], expiresInDays: 1 },
      }),
    ),
  );
  assert(burst.every((response) => response.status() === 201));
  for (let i = 0; i < 100 && notifications.length < beforeBurst + 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    notifications.length,
    beforeBurst + 2,
    'Concurrent distinct notices are not lost or duplicated across tabs',
  );

  const external = await browser.newContext();
  const externalApi = external.request;
  const bearer = { authorization: `Bearer ${token}` };
  let seq = 0;
  const rpc = (method, params = {}) =>
    externalApi.post(`${base}/mcp`, {
      headers: { ...bearer, accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: ++seq, method, params },
    });
  await writer.goto(`${base}/inbox`);
  await writer.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  await writer.keyboard.press('q');
  const dialog = writer.getByRole('dialog', { name: 'Quick add', exact: true });
  await dialog.getByRole('textbox', { name: 'Task name', exact: true }).fill('Manual live fixture');
  await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
  await observer.getByRole('group', { name: 'Manual live fixture', exact: true }).waitFor();
  const added = await rpc('tools/call', {
    name: 'add_task',
    arguments: { text: 'MCP live fixture' },
  });
  assert.equal(added.status(), 200);
  assert(!(await added.json()).result.isError);
  await writer.getByRole('group', { name: 'MCP live fixture', exact: true }).waitFor();
  await observer.getByRole('group', { name: 'MCP live fixture', exact: true }).waitFor();
  await observer.goto(`${base}/habits`);
  await observer.getByRole('heading', { name: 'Habits', exact: true }).waitFor();
  const habitReply = await rpc('tools/call', {
    name: 'add_habit',
    arguments: { name: 'MCP live habit', period: 'day', target: 1 },
  });
  const habit = (await habitReply.json()).result.structuredContent.habit;
  await observer.getByRole('region', { name: 'MCP live habit', exact: true }).waitFor();
  const today = (await (await api.get(`${base}/api/v1/habits`)).json()).today;
  const check = await rpc('tools/call', {
    name: 'set_habit_check_in',
    arguments: { id: habit.id, date: today, completed: true },
  });
  assert(!(await check.json()).result.isError);
  await observer.getByRole('button', { name: 'Today: MCP live habit', exact: true }).waitFor();
  await observer.waitForFunction(
    () =>
      globalThis.document
        .querySelector('button[aria-label="Today: MCP live habit"]')
        ?.getAttribute('aria-pressed') === 'true',
  );
  // Actual PKCE OAuth exchange, using this test account's explicit consent.
  const redirect = 'http://127.0.0.1:56789/callback';
  const client = await (
    await api.post(`${base}/oauth/register`, {
      data: {
        client_name: 'Live fixture client',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
      },
    })
  ).json();
  const verifier = randomBytes(32).toString('base64url');
  const auth = await api.get(
    `${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${base}/mcp`, scope: 'tasks:read habits:read habits:write' })}`,
    { maxRedirects: 0 },
  );
  assert.equal(auth.status(), 302);
  const decision = await api.post(`${base}/api/v1/oauth/request/decision`, {
    headers,
    data: { request: new URL(auth.headers().location).hash.slice(1), approve: true },
  });
  assert.equal(decision.status(), 200);
  const code = new URL((await decision.json()).redirect).searchParams.get('code');
  const exchange = await api.post(`${base}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
    },
  });
  assert.equal(exchange.status(), 200);
  const access = (await exchange.json()).access_token;
  const oauthPing = () =>
    externalApi.post(`${base}/mcp`, {
      headers: { authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: ++seq, method: 'ping' },
    });
  await writer.goto(`${base}/settings/apps`);
  const prompt = writer.getByRole('textbox', {
    name: 'Connection prompt for any agent',
    exact: true,
  });
  await prompt.waitFor();
  assert((await prompt.inputValue()).includes('Try browser sign-in first'));
  const policy = writer.getByRole('combobox', { name: 'MCP authentication policy', exact: true });
  await policy.selectOption('sign-in');
  await writer.waitForFunction(() =>
    globalThis.document
      .querySelector('#mcp-connection-prompt')
      ?.value.includes('sign-in authentication only'),
  );
  assert.equal((await rpc('ping')).status(), 401);
  assert.equal((await oauthPing()).status(), 200);
  assert.equal((await externalApi.get(`${base}/api/v1/tasks`, { headers: bearer })).status(), 200);
  await policy.selectOption('pat');
  await writer.waitForFunction(() =>
    globalThis.document
      .querySelector('#mcp-connection-prompt')
      ?.value.includes('requires a personal access token for MCP'),
  );
  assert.equal((await oauthPing()).status(), 401);
  assert.equal((await rpc('ping')).status(), 200);
  await policy.selectOption('both');
  await writer.waitForFunction(() =>
    globalThis.document
      .querySelector('#mcp-connection-prompt')
      ?.value.includes('Try browser sign-in first'),
  );
  assert.equal((await oauthPing()).status(), 200);
  assert(!(await prompt.inputValue()).includes(token));
  assert(!/Hermes|n8n/.test(await writer.locator('main').innerText()));
  // Persist a real offline snapshot, close all tabs, then create a notice while closed.
  await writer.goto(`${base}/inbox`);
  await writer.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  await writer.evaluate(() => globalThis.localStorage.setItem('bokydo.offline', '1'));
  const cachedTask = (
    await (
      await rpc('tools/call', { name: 'add_task', arguments: { text: 'Offline baseline fixture' } })
    ).json()
  ).result.structuredContent.task;
  await writer.waitForFunction(
    async (id) =>
      new Promise((resolve) => {
        const open = globalThis.indexedDB.open('bokydo-offline');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('snapshots')) {
            db.close();
            resolve(false);
            return;
          }
          const req = db.transaction('snapshots').objectStore('snapshots').getAll();
          req.onsuccess = () => {
            const found = req.result.some((snapshot) =>
              snapshot.state.tasks.some(([key]) => key === id),
            );
            db.close();
            resolve(found);
          };
          req.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      }),
    cachedTask.id,
  );
  await observer.goto(`${base}/inbox`);
  await observer.getByRole('group', { name: 'Offline baseline fixture', exact: true }).waitFor();
  await writer.waitForFunction(() => !!globalThis.localStorage.getItem('bokydo.offline.user'));
  const priorNotices = (
    await (
      await api.post(`${base}/api/v1/sync`, { headers, data: { cursor: null, commands: [] } })
    ).json()
  ).notifications.length;
  await writer.close();
  await observer.close();
  const beforeReplay = notifications.length;
  assert.equal(
    (
      await api.post(`${base}/api/v1/account/tokens`, {
        headers,
        data: { name: 'Created while closed', scopes: ['tasks:read'], expiresInDays: 1 },
      })
    ).status(),
    201,
  );
  for (let i = 0; i < 30; i++) {
    const count = (
      await (
        await api.post(`${base}/api/v1/sync`, { headers, data: { cursor: null, commands: [] } })
      ).json()
    ).notifications.length;
    if (count > priorNotices) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const reopened = await context.newPage();
  debugPage = reopened;
  let releaseSync;
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  let first = true;
  let syncStarted;
  const firstSyncStarted = new Promise((resolve) => {
    syncStarted = resolve;
  });
  await reopened.route('**/api/v1/sync', async (route) => {
    if (first) {
      first = false;
      syncStarted();
      await syncGate;
    }
    return route.continue();
  });
  await reopened.goto(`${base}/inbox`);
  await firstSyncStarted;
  if (kind === 'chromium')
    await reopened.getByRole('group', { name: 'Offline baseline fixture', exact: true }).waitFor();
  assert.equal(
    notifications.length,
    beforeReplay,
    'Offline hydration never displays historical notices',
  );
  const refreshed = reopened.waitForResponse(
    (response) => response.url() === `${base}/api/v1/sync` && response.status() === 200,
  );
  releaseSync();
  await refreshed;
  await reopened.getByRole('group', { name: 'Offline baseline fixture', exact: true }).waitFor();
  await reopened.unroute('**/api/v1/sync');
  // A focus roundtrip after the first server snapshot must not replay closed-tab notices.
  const caughtUp = reopened.waitForResponse(
    (response) => response.url() === `${base}/api/v1/sync` && response.status() === 200,
  );
  await reopened.evaluate(() => globalThis.window.dispatchEvent(new Event('focus')));
  await caughtUp;
  assert.equal(
    notifications.length,
    beforeReplay,
    'Fresh server baseline suppresses notices from while app was closed',
  );
  assert.equal(
    (
      await api.post(`${base}/api/v1/account/tokens`, {
        headers,
        data: { name: 'Created while reopened', scopes: ['tasks:read'], expiresInDays: 1 },
      })
    ).status(),
    201,
  );
  for (let i = 0; i < 100 && notifications.length === beforeReplay; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    notifications.length,
    beforeReplay + 1,
    'New notices still deliver after server-baseline catchup',
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS ${kind}: Google-free local notifications, cross-tab/MCP task and habit refresh, PKCE sign-in and credential-policy switching`,
  );
} catch (error) {
  if (debugPage && !debugPage.isClosed())
    console.error(
      await debugPage.evaluate(() => ({
        url: globalThis.location.href,
        offline: globalThis.localStorage.getItem('bokydo.offline'),
        remembered: !!globalThis.localStorage.getItem('bokydo.offline.user'),
        groups: [...globalThis.document.querySelectorAll('[role=group]')].map((element) =>
          element.getAttribute('aria-label'),
        ),
        text: globalThis.document.querySelector('main')?.innerText.slice(0, 250),
      })),
    );
  throw error;
} finally {
  await browser.close();
}
