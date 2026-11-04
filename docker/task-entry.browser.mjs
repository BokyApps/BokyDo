/**
 * Browser regression against a FRESH, throwaway local stack (creates its only user/tasks).
 * Install playwright-core outside the repo and point NODE_PATH at its node_modules, then run:
 * BOKYDO_TEST_BASE_URL=http://127.0.0.1:18090 BOKYDO_BROWSER_EXECUTABLE=/path/to/chromium \
 *   NODE_PATH=/tmp/browser-tests/node_modules node docker/task-entry.browser.mjs
 * Keep this outside the API smoke test: the zero-height dialog bug needs a real layout engine.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const base = process.env.BOKYDO_TEST_BASE_URL;
assert(base, 'Set BOKYDO_TEST_BASE_URL to a fresh throwaway stack');
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname),
  'This test creates fixture data and may only run against loopback',
);
const browser = await chromium.launch({
  executablePath: process.env.BOKYDO_BROWSER_EXECUTABLE,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const context = await browser.newContext({ timezoneId: 'UTC' });
  context.setDefaultTimeout(15000);
  const api = context.request;
  const instance = await (await api.get(`${base}/api/v1/instance`)).json();
  assert(instance.initialAdminRequired, 'Refusing to modify an initialized instance');
  const signup = await api.post(`${base}/api/v1/setup/admin`, {
    headers: { origin: base },
    data: { username: 'browser-fixture', password: 'violin-pancake-orbit-meadow' },
  });
  assert.equal(signup.status(), 201, await signup.text());
  const { csrfToken } = await signup.json();
  const headers = { origin: base, 'x-csrf-token': csrfToken };
  assert(
    (await api.put(`${base}/api/v1/setup/public-url`, { headers, data: { publicUrl: base } })).ok(),
  );
  assert((await api.post(`${base}/api/v1/setup/complete`, { headers })).ok());

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/inbox`);
  await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  // Poll the server rather than trusting an optimistic row in the browser's local cache.
  const saved = async (content) => {
    const handle = await page.waitForFunction(
      async (name) => {
        const response = await fetch('/api/v1/tasks');
        if (!response.ok) return false;
        return (await response.json()).tasks.find((task) => task.content === name) ?? false;
      },
      content,
      { polling: 200 },
    );
    const task = await handle.jsonValue();
    assert(task, `Task ${content} must reach the server`);
    return task;
  };
  const verify = (task, date, priority) => {
    assert.equal(task.due?.date, date);
    assert.equal(task.priority, priority);
  };
  const quickAdd = async () => {
    await page.keyboard.press('q');
    const dialog = page.getByRole('dialog', { name: 'Quick add', exact: true });
    await dialog.waitFor();
    const name = dialog.getByRole('textbox', { name: 'Task name', exact: true });
    assert((await name.boundingBox())?.height >= 24, 'Task name must have a visible line');
    return { dialog, name };
  };

  // The task name must be usable immediately after the native dialog is opened.
  let { dialog, name } = await quickAdd();
  await name.fill('Quick entry today p1');
  assert(await dialog.getByRole('list', { name: 'Recognised in the task name' }).isVisible());
  assert(await dialog.getByRole('button', { name: 'Add task', exact: true }).isEnabled());
  await dialog.getByRole('button', { name: 'Add task', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const parent = await saved('Quick entry');
  verify(parent, today, 1);

  // Reopening and submitting by keyboard must preserve parsed values too.
  ({ dialog, name } = await quickAdd());
  await name.fill('Keyboard entry tomorrow p2');
  await name.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  verify(await saved('Keyboard entry'), tomorrow, 2);

  await page.getByRole('group', { name: 'Quick entry', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Quick entry', exact: true });
  await detail.getByRole('button', { name: /Add sub-task$/ }).click();
  const subtask = detail.getByPlaceholder('Sub-task name', { exact: true });
  await subtask.fill('Child entry tomorrow p3');
  assert(await detail.getByRole('list', { name: 'Recognised in the task name' }).isVisible());
  await detail.getByRole('button', { name: 'Add task', exact: true }).click();
  const child = await saved('Child entry');
  verify(child, tomorrow, 3);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.projectId, parent.projectId);
  // keepOpen clears the field; it must retain its one-line height for the next child.
  assert((await subtask.boundingBox())?.height >= 24);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Reload using a new context so neither React state nor IndexedDB can hide a failed save.
  const fresh = await browser.newContext({
    storageState: await context.storageState(),
    timezoneId: 'UTC',
  });
  fresh.setDefaultTimeout(15000);
  const reloaded = await fresh.newPage();
  reloaded.on('pageerror', (error) => errors.push(error.message));
  await reloaded.goto(`${base}/inbox`);
  await reloaded.getByRole('group', { name: 'Quick entry', exact: true }).waitFor();
  await reloaded.getByRole('group', { name: 'Keyboard entry', exact: true }).waitFor();
  await reloaded.getByRole('group', { name: 'Quick entry', exact: true }).click();
  await reloaded
    .getByRole('dialog', { name: 'Quick entry', exact: true })
    .getByRole('group', { name: 'Child entry', exact: true })
    .waitFor();
  await reloaded.keyboard.press('Escape');

  await reloaded.getByRole('button', { name: 'View', exact: true }).click();
  const layouts = reloaded.getByRole('group', { name: 'Layout', exact: true });
  for (const label of ['List', 'Board', 'Calendar']) {
    const button = layouts.getByRole('button', { name: label, exact: true });
    assert(await button.isVisible());
    assert.equal(await button.locator('svg').count(), 1);
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
  }
  assert(!(await layouts.innerText()).includes('view.'));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: quick add, keyboard submit, parsed dates/priorities, persisted subtasks, View icons',
  );
} finally {
  await browser.close();
}
