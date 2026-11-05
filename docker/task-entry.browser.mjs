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
  const context = await browser.newContext({ timezoneId: 'UTC', serviceWorkers: 'block' });
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
    serviceWorkers: 'block',
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
  await reloaded.getByRole('link', { name: 'Habits', exact: true }).click();
  await reloaded.getByRole('heading', { name: 'Habits', exact: true }).waitFor();
  assert.equal(await reloaded.getByRole('link', { name: 'Productivity', exact: true }).count(), 0);
  assert(!(await reloaded.locator('main').innerText()).includes('Karma'));
  assert.equal((await api.get(`${base}/api/v1/productivity`)).status(), 404);

  // Lose a response after committing. A stable draft ID must prevent duplicate creation, and
  // pending saves must resist dismissal or opening another editor.
  let releaseCreate;
  let createReached;
  const release = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const reached = new Promise((resolve) => {
    createReached = resolve;
  });
  let loseResponse = true;
  await reloaded.route('**/api/v1/habits', async (route) => {
    if (route.request().method() === 'POST' && loseResponse) {
      loseResponse = false;
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      createReached();
      await release;
      await route.abort('failed');
    } else await route.continue();
  });
  await reloaded.getByRole('button', { name: 'Add habit', exact: true }).click();
  let habitDialog = reloaded.getByRole('dialog', { name: 'New habit', exact: true });
  await habitDialog.getByRole('textbox', { name: 'Habit name' }).fill('Read daily');
  await habitDialog.getByRole('button', { name: 'Create habit', exact: true }).click();
  await reached;
  assert(await reloaded.getByRole('button', { name: 'Add habit', exact: true }).isDisabled());
  assert(await habitDialog.getByRole('textbox', { name: 'Habit name' }).isDisabled());
  await reloaded.keyboard.press('Escape');
  assert(await habitDialog.isVisible());
  await reloaded.mouse.click(1, 1);
  assert(await habitDialog.isVisible());
  releaseCreate();
  await habitDialog.getByRole('alert').waitFor();
  await habitDialog.getByRole('button', { name: 'Create habit', exact: true }).click();
  await habitDialog.waitFor({ state: 'hidden' });
  await reloaded.unroute('**/api/v1/habits');
  let habits = await (await api.get(`${base}/api/v1/habits`)).json();
  assert.equal(habits.habits.length, 1, 'Lost responses must not create duplicate habits');
  assert((await api.post(`${base}/api/v1/tasks/${parent.id}/complete`, { headers })).ok());
  habits = await (await api.get(`${base}/api/v1/habits`)).json();
  assert.equal(habits.habits[0].progress.completed, 0, 'Normal tasks must not count as habits');
  assert.equal(habits.habits[0].streak.current, 0);
  await reloaded.getByRole('button', { name: 'Today: Read daily', exact: true }).click();
  await reloaded.getByRole('button', { name: 'Today: Read daily', pressed: true }).waitFor();
  const yesterday = new Date(`${habits.today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayDate = yesterday.toISOString().slice(0, 10);
  const history = reloaded.getByRole('group', { name: 'Read daily check-in history', exact: true });
  assert.equal(await history.getByRole('button').count(), 14);
  await history
    .getByRole('button', { name: `${yesterdayDate}, Read daily, not completed`, exact: true })
    .click();
  await reloaded.getByText('2 day streak', { exact: true }).waitFor();

  await reloaded.getByRole('button', { name: 'Add habit', exact: true }).click();
  habitDialog = reloaded.getByRole('dialog', { name: 'New habit', exact: true });
  await habitDialog.getByRole('textbox', { name: 'Habit name' }).fill('Walk');
  await habitDialog.getByLabel('Frequency', { exact: true }).selectOption('week');
  await habitDialog.getByRole('spinbutton', { name: 'Target each week' }).fill('3');
  await habitDialog.getByRole('button', { name: 'Create habit', exact: true }).click();
  await habitDialog.waitFor({ state: 'hidden' });
  const walk = reloaded.getByRole('region', { name: 'Walk', exact: true });
  await walk.getByRole('button', { name: 'Edit', exact: true }).click();
  habitDialog = reloaded.getByRole('dialog', { name: 'Edit habit', exact: true });
  await habitDialog.getByRole('spinbutton', { name: 'Target each week' }).fill('2');
  await habitDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await habitDialog.waitFor({ state: 'hidden' });
  await walk.getByText('2 days a week · 0/2 this period', { exact: true }).waitFor();
  await reloaded.reload();
  await reloaded.getByRole('button', { name: 'Today: Read daily', pressed: true }).waitFor();
  await reloaded.getByText('2 day streak', { exact: true }).waitFor();
  await reloaded
    .getByRole('region', { name: 'Walk', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await reloaded
    .getByRole('dialog', { name: 'Delete habit?', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await reloaded.getByRole('region', { name: 'Walk', exact: true }).waitFor({ state: 'hidden' });
  habits = await (await api.get(`${base}/api/v1/habits`)).json();
  assert.equal(habits.habits.length, 1);
  assert.equal(habits.habits[0].name, 'Read daily');
  assert.deepEqual(errors, []);
  // Keep a non-Latin subset pending to prove that switching waits for every font file.
  const gate = () => {
    let resolve;
    const wait = new Promise((done) => {
      resolve = done;
    });
    return { wait, release: () => resolve() };
  };
  const firaExtended = gate();
  const firaSeen = gate();
  const lexend = gate();
  const lexendSeen = gate();
  await reloaded.route('**/*.woff2', async (route) => {
    const url = route.request().url();
    if (url.includes('fira-code-latin-ext')) {
      firaSeen.release();
      await firaExtended.wait;
    } else if (url.includes('lexend-')) {
      lexendSeen.release();
      await lexend.wait;
    }
    await route.continue();
  });
  await reloaded.getByRole('button', { name: /account menu/ }).click();
  assert.equal(await reloaded.getByRole('button', { name: /^Admin:/ }).count(), 0);
  assert.equal(
    await reloaded.getByRole('button', { name: 'Account security', exact: true }).count(),
    0,
  );
  await reloaded.getByRole('button', { name: 'Settings', exact: true }).click();
  const sections = reloaded.getByRole('navigation', { name: 'Settings sections', exact: true });
  await sections.getByRole('link', { name: 'Themes', exact: true }).waitFor();
  await reloaded.getByRole('heading', { name: 'Fonts', exact: true }).waitFor();
  const font = reloaded.getByRole('combobox', { name: 'Font', exact: true });
  assert.equal(await font.getByRole('option').count(), 7);
  assert.equal(await font.getByRole('option', { name: 'System', exact: true }).count(), 0);
  await font.selectOption('fira-code');
  const bounded = (promise) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Font request not observed')), 15000),
      ),
    ]);
  await bounded(firaSeen.wait);
  const currentFont = () =>
    reloaded.evaluate(() =>
      globalThis.document.documentElement.style.getPropertyValue('--bk-font'),
    );
  assert(
    (await currentFont()).startsWith('"Inter Variable"'),
    'Keep current font until all subsets load',
  );
  await font.selectOption('lexend');
  await bounded(lexendSeen.wait);
  lexend.release();
  await reloaded.waitForFunction(() =>
    globalThis.document.documentElement.style
      .getPropertyValue('--bk-font')
      .startsWith('"Lexend Variable"'),
  );
  firaExtended.release();
  await reloaded.waitForFunction(() =>
    [...globalThis.document.fonts]
      .filter((face) => face.family.includes('Fira Code'))
      .every((face) => face.status === 'loaded'),
  );
  assert(
    (await currentFont()).startsWith('"Lexend Variable"'),
    'A slow older choice must not overwrite the latest font',
  );
  await reloaded.unroute('**/*.woff2');

  const cdp = await fresh.newCDPSession(reloaded);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await reloaded.evaluate(() => {
    const sample = globalThis.document.createElement('p');
    sample.id = 'font-regression-sample';
    sample.textContent = 'Readable Łódź Ελληνικά Привет';
    globalThis.document.querySelector('main').append(sample);
  });
  const actualFonts = async (selector) => {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    return (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
  };
  for (const [id, family] of [
    ['inter', 'Inter Variable'],
    ['ibm-plex-sans', 'IBM Plex Sans'],
    ['atkinson', 'Atkinson Hyperlegible'],
    ['lexend', 'Lexend Variable'],
    ['opendyslexic', 'OpenDyslexic'],
    ['jetbrains-mono', 'JetBrains Mono Variable'],
    ['fira-code', 'Fira Code Variable'],
  ]) {
    await font.selectOption(id);
    await reloaded.waitForFunction(
      (name) =>
        globalThis.document.documentElement.style
          .getPropertyValue('--bk-font')
          .startsWith(`"${name}"`),
      family,
    );
    const rendered = await actualFonts('#font-regression-sample');
    assert(
      rendered.length > 0 && rendered.every((entry) => entry.isCustomFont),
      `No system fallback for ${id}`,
    );
    const logo = await actualFonts('.font-brand');
    assert(
      logo.length > 0 &&
        logo.every((entry) => entry.isCustomFont && entry.familyName.includes('JetBrains')),
      'Logo stays JetBrains Mono',
    );
  }
  const families = [
    ['Doist', 'bokydo-light', 'bokydo-dark'],
    ['Catppuccin', 'catppuccin-latte', 'catppuccin-mocha'],
    ['Gruvbox', 'gruvbox-light', 'gruvbox-dark'],
    ['Dracula', 'dracula-alucard', 'dracula'],
    ['Nord', 'nord-light', 'nord'],
    ['Tokyo Night', 'tokyonight-day', 'tokyonight-night'],
    ['Solarized', 'solarized-light', 'solarized-dark'],
    ['One Dark / One Light', 'one-light', 'one-dark'],
    ['Rosé Pine', 'rosepine-dawn', 'rosepine'],
    ['Everforest', 'everforest-light', 'everforest-dark'],
    ['Kanagawa', 'kanagawa-lotus', 'kanagawa-wave'],
  ];
  for (const [mode, column] of [
    ['Light', 1],
    ['Dark', 2],
  ]) {
    await reloaded.getByRole('button', { name: mode, exact: true }).click();
    for (const family of families) {
      await reloaded.getByRole('button', { name: family[0], exact: true }).click();
      await reloaded.waitForFunction(
        (id) => globalThis.document.documentElement.dataset.theme === id,
        family[column],
      );
    }
  }
  await sections.getByRole('link', { name: 'Notifications', exact: true }).click();
  await sections.getByRole('link', { name: 'Themes', exact: true }).click();
  await reloaded.goBack();
  assert.equal(
    await sections
      .getByRole('link', { name: 'Notifications', exact: true })
      .getAttribute('aria-current'),
    'page',
  );
  await sections.getByRole('link', { name: 'Account security', exact: true }).click();
  await reloaded.getByRole('heading', { name: 'Two-factor authentication', exact: true }).waitFor();
  await reloaded.goto(`${base}/admin/backups`);
  await reloaded.waitForURL(`${base}/settings/admin/backups`);
  await reloaded.getByRole('navigation', { name: 'Settings sections', exact: true }).waitFor();
  await reloaded.goto(`${base}/settings/themes`);
  await reloaded.getByRole('combobox', { name: 'Font', exact: true }).waitFor();
  assert.equal(await font.inputValue(), 'fira-code');
  assert.equal(
    await reloaded.evaluate(() => globalThis.document.documentElement.dataset.theme),
    'kanagawa-wave',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: task and habit entry, unified Settings, all theme families, bundled font switching/subsets/races and fixed logo',
  );
} finally {
  await browser.close();
}
