/** Browser interaction regression, restricted to a fresh loopback stack. */
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
  const context = await browser.newContext({
    timezoneId: 'UTC',
    viewport: { width: 1280, height: 1000 },
    serviceWorkers: 'block',
  });
  context.setDefaultTimeout(15000);
  const api = context.request;
  assert(
    (await (await api.get(`${base}/api/v1/instance`)).json()).initialAdminRequired,
    'Refusing initialized instance',
  );
  const signup = await api.post(`${base}/api/v1/setup/admin`, {
    headers: { origin: base },
    data: { username: 'view-fixture', password: 'violin-pancake-orbit-meadow' },
  });
  assert.equal(signup.status(), 201);
  const headers = { origin: base, 'x-csrf-token': (await signup.json()).csrfToken };
  const post = async (path, data) => {
    const r = await api.post(`${base}${path}`, { headers, data });
    assert(r.ok(), `${path}: ${r.status()}`);
    const body = await r.text();
    return body ? JSON.parse(body) : null;
  };
  assert(
    (await api.put(`${base}/api/v1/setup/public-url`, { headers, data: { publicUrl: base } })).ok(),
  );
  await post('/api/v1/setup/complete');
  const first = (await post('/api/v1/tasks', { content: 'Complete without reloading' })).task;
  const remote = (await post('/api/v1/tasks', { content: 'Remote completion' })).task;
  const inactive = (await post('/api/v1/tasks', { content: 'Cached history completion' })).task;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Local writes must refresh history even when the event stream is unavailable.
  await page.route('**/api/v1/sync/events', (route) => route.abort());
  await page.goto(`${base}/inbox`);
  await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  let releaseHistory;
  let capturedHistory;
  let deliveredHistory;
  const held = new Promise((resolve) => {
    releaseHistory = resolve;
  });
  const captured = new Promise((resolve) => {
    capturedHistory = resolve;
  });
  const delivered = new Promise((resolve) => {
    deliveredHistory = resolve;
  });
  let historyRequests = 0;
  await page.route('**/api/v1/tasks/completed?*', async (route) => {
    historyRequests++;
    if (historyRequests !== 1) return route.continue();
    const response = await route.fetch();
    assert.equal((await response.json()).tasks.length, 0);
    capturedHistory();
    await held;
    await route.fulfill({ response });
    deliveredHistory();
  });
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Show completed tasks', exact: true }).check();
  await page.keyboard.press('Escape');
  const history = page.getByRole('region', { name: 'Completed tasks', exact: true });
  const row = (scope, name) => scope.getByRole('group', { name, exact: true });
  const checkbox = (scope, name) => row(scope, name).getByRole('checkbox');
  await captured;
  await checkbox(page, first.content).click();
  await row(history, first.content).waitFor();
  assert.equal(await checkbox(history, first.content).getAttribute('aria-checked'), 'true');
  assert(historyRequests >= 2, 'Replace the held initial snapshot with a post-completion GET');
  releaseHistory();
  await delivered;
  await row(history, first.content).waitFor();
  await checkbox(history, first.content).click();
  await row(history, first.content).waitFor({ state: 'hidden' });
  await row(page, first.content).waitFor();
  await checkbox(page, first.content).click();
  await row(history, first.content).waitFor();
  await page.keyboard.press('Control+z');
  await row(history, first.content).waitFor({ state: 'hidden' });
  await row(page, first.content).waitFor();

  // Prime the global history cache, then change a task while that query is inactive.
  await page.getByRole('link', { name: 'Completed', exact: true }).click();
  await page.getByRole('heading', { name: 'Completed', exact: true }).waitFor();
  await page.getByText('No completed tasks.', { exact: true }).waitFor();
  await page.locator('a[href="/inbox"]').click();
  await checkbox(page, inactive.content).click();
  await row(history, inactive.content).waitFor();
  await page.getByRole('link', { name: 'Completed', exact: true }).click();
  await row(page, inactive.content).waitFor();

  // A second mounted history observes changes through the server event stream.
  const live = await context.newPage();
  live.on('pageerror', (error) => errors.push(error.message));
  await live.goto(`${base}/completed`);
  await row(live, inactive.content).waitFor();
  await post(`/api/v1/tasks/${remote.id}/complete`);
  await row(live, remote.content).waitFor({ timeout: 5000 });
  await post(`/api/v1/tasks/${remote.id}/uncomplete`);
  await row(live, remote.content).waitFor({ state: 'hidden', timeout: 5000 });

  // Returning from a lost connection/focus also catches up the cached history.
  await post(`/api/v1/tasks/${first.id}/complete`);
  await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  await row(page, first.content).waitFor({ timeout: 5000 });
  const persisted = (await (await api.get(`${base}/api/v1/tasks/${first.id}`)).json()).task;
  assert(persisted.isCompleted);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: project and global Completed history refresh after checkbox complete/reopen/undo, inactive cache, remote writes, and focus catch-up without reload',
  );
} finally {
  await browser.close();
}
