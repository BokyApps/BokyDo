/** Notification Settings regression on a fresh local stack; browser failures are simulated. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const base = process.env.BOKYDO_TEST_BASE_URL;
assert(
  base && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname),
  'Use a fresh loopback stack',
);
const browser = await chromium.launch({
  executablePath: process.env.BOKYDO_BROWSER_EXECUTABLE,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const context = await browser.newContext({ permissions: ['notifications'] });
  context.setDefaultTimeout(15000);
  const api = context.request;
  assert(
    (await (await api.get(`${base}/api/v1/instance`)).json()).initialAdminRequired,
    'Refusing an initialized instance',
  );
  const signup = await api.post(`${base}/api/v1/setup/admin`, {
    headers: { origin: base },
    data: { username: 'push-fixture', password: 'violin-pancake-orbit-meadow' },
  });
  assert.equal(signup.status(), 201);
  const headers = { origin: base, 'x-csrf-token': (await signup.json()).csrfToken };
  assert(
    (await api.put(`${base}/api/v1/setup/public-url`, { headers, data: { publicUrl: base } })).ok(),
  );
  assert((await api.post(`${base}/api/v1/setup/complete`, { headers })).ok());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let saveFails = false;
  let saves = 0;
  await page.route('**/api/v1/push/subscriptions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    saves++;
    return route.fulfill({
      status: saveFails ? 503 : 204,
      ...(saveFails ? { contentType: 'application/json', body: '{"error":"unavailable"}' } : {}),
    });
  });
  await page.goto(`${base}/settings/notifications`);
  const section = page
    .getByRole('heading', { name: 'Push notifications on this device', exact: true })
    .locator('..');
  const on = section.getByRole('button', { name: 'Turn on', exact: true });
  await on.waitFor();
  // Real service-worker setup; simulate the AbortError Brave returns when its push service is off.
  await page.evaluate(() => {
    globalThis.PushManager.prototype.subscribe = async () => {
      throw new DOMException('Registration failed - push service error', 'AbortError');
    };
  });
  await on.click();
  await section
    .getByRole('status')
    .filter({ hasText: 'Use Google services for push messaging' })
    .waitFor();
  assert.equal(saves, 0);
  assert(await on.isEnabled(), 'A failed subscription remains retryable');
  // After enabling the browser service, test server failure separately and then retry successfully.
  await page.evaluate(() => {
    globalThis.PushManager.prototype.subscribe = async (options) => ({
      endpoint: 'https://fcm.googleapis.com/push-browser-fixture',
      options,
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/push-browser-fixture', keys: {} }),
    });
  });
  saveFails = true;
  await on.click();
  await section.getByRole('status').filter({ hasText: 'BokyDo could not load or save' }).waitFor();
  assert(!(await section.getByRole('status').innerText()).includes('Brave'));
  saveFails = false;
  await on.click();
  await section.getByRole('button', { name: 'Send a test', exact: true }).waitFor();
  assert.equal(saves, 2);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: simulated Brave push failure shows guidance, retry works, server failure stays distinct, successful setup shows On',
  );
} finally {
  await browser.close();
}
