/** Browser interaction regression, restricted to a fresh loopback stack. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const dates = {
    due: {
      date: yesterday,
      time: '17:00',
      timezone: 'UTC',
      string: `${yesterday} 17:00`,
      recurrence: null,
    },
    deadline: yesterday,
  };
  const completed = (await post('/api/v1/tasks', { content: 'Completed old dates', ...dates }))
    .task;
  await post(`/api/v1/tasks/${completed.id}/complete`);
  await post('/api/v1/tasks', { content: 'Open old dates', ...dates });
  const habit = (
    await post('/api/v1/habits', { name: 'Daily overview habit', period: 'day', target: 1 })
  ).habit;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const row = (name) => page.getByRole('group', { name, exact: true });
  const overview = () => page.getByRole('region', { name: 'Habits overview', exact: true });
  const restoreHabits = async () => {
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Show habits', exact: true }).check();
    await page.keyboard.press('Escape');
    await overview().waitFor();
  };
  await page.goto(`${base}/completed`);
  const completedRow = row('Completed old dates');
  await completedRow.waitFor();
  const due = completedRow.locator('span').filter({ hasText: /^\s*Yesterday\s+17:00\s*$/ });
  const deadline = completedRow.locator('[title="Deadline"]');
  const muted = await completedRow
    .getByText('Completed old dates', { exact: true })
    .evaluate((element) => globalThis.getComputedStyle(element).color);
  assert.equal(await due.evaluate((element) => globalThis.getComputedStyle(element).color), muted);
  assert.equal(
    await deadline.evaluate((element) => globalThis.getComputedStyle(element).color),
    muted,
  );
  await page.goto(`${base}/inbox`);
  const openRow = row('Open old dates');
  await openRow.waitFor();
  assert(
    await openRow
      .locator('[title="Deadline"]')
      .evaluate((element) => element.classList.contains('text-danger')),
  );
  assert(
    await openRow
      .locator('span')
      .filter({ hasText: /^\s*Yesterday\s+17:00\s*$/ })
      .evaluate((element) => element.classList.contains('text-danger')),
  );
  await overview().waitFor();
  assert(await overview().evaluate((element) => element.classList.contains('border-dashed')));
  const check = overview().getByRole('button', {
    name: 'Today: Daily overview habit',
    exact: true,
  });
  await check.click();
  await page.waitForFunction(
    () =>
      globalThis.document
        .querySelector('[aria-label="Today: Daily overview habit"]')
        ?.getAttribute('aria-pressed') === 'true',
  );
  const serverHabits = (await (await api.get(`${base}/api/v1/habits`)).json()).habits;
  assert.equal(serverHabits.find((item) => item.id === habit.id).todayCompleted, true);
  await overview().getByRole('button', { name: 'Hide habits', exact: true }).click();
  await overview().waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  assert.equal(await overview().count(), 0);
  await page.goto(`${base}/today`);
  await overview().waitFor();
  assert.equal(
    await overview()
      .getByRole('button', { name: 'Today: Daily overview habit', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await overview().getByRole('button', { name: 'Hide habits', exact: true }).click();
  await page.reload();
  await page.getByRole('heading', { name: 'Today', exact: true }).waitFor();
  assert.equal(await overview().count(), 0);
  await restoreHabits();
  await page.goto(`${base}/inbox`);
  await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  assert.equal(await overview().count(), 0);
  await restoreHabits();
  const project = (await post('/api/v1/projects', { name: 'Drag fixture project' })).project;
  const a = randomUUID(),
    b = randomUUID(),
    c = randomUUID();
  const commands = [
    ['A section', a, 'a0'],
    ['Empty section', b, 'a1'],
    ['Keyboard section', c, 'a2'],
  ].map(([name, id, sectionOrder]) => ({
    type: 'section_add',
    uuid: randomUUID(),
    args: { id, name, projectId: project.id, sectionOrder },
  }));
  const synced = await post('/api/v1/sync', { cursor: null, commands });
  assert(Object.values(synced.results).every((result) => result.ok));
  const task = async (content, sectionId, childOrder, parentId = null) =>
    (
      await post('/api/v1/tasks', {
        content,
        projectId: project.id,
        sectionId,
        childOrder,
        parentId,
      })
    ).task;
  const first = await task('Drag first', a, 'a0');
  const second = await task('Drag second', a, 'a1');
  const parent = await task('Parent fixture', a, 'a2');
  const child = await task('Nested child', a, 'a0', parent.id);
  const keyboardOne = await task('Keyboard one', c, 'a0');
  const keyboardTwo = await task('Keyboard two', c, 'a1');
  await page.goto(`${base}/project/${project.id}`);
  await row('Drag first').waitFor();
  assert.equal(await overview().count(), 0, 'Ordinary projects do not show personal habits');
  const preview = () => page.locator('[aria-hidden="true"].shadow-xl');
  const read = async (id) => (await (await api.get(`${base}/api/v1/tasks/${id}`)).json()).task;
  const saved = async (id, predicate) => {
    for (let i = 0; i < 100; i++) {
      const value = await read(id);
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Dragged placement was not saved');
  };
  const pickup = async (name) => {
    const handle = row(name).getByRole('button', { name: 'Drag to reorder', exact: true });
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    assert(box);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y + 7, { steps: 3 });
    await preview().waitFor();
    return point;
  };
  // Keep x in the desktop handle gutter: vertical drags must still hit rows.
  let source = await pickup('Drag first');
  assert((await row('Drag first').locator('..').getAttribute('class')).includes('opacity-25'));
  let target = await row('Drag second').boundingBox();
  assert(target);
  await page.mouse.move(source.x, target.y + target.height / 2, { steps: 10 });
  await row('Drag second')
    .locator('..')
    .evaluate((element) => {
      if (!element.className.includes('after:bg-accent')) throw new Error('Missing insertion cue');
    });
  await page.mouse.up();
  await preview().waitFor({ state: 'hidden' });
  await saved(
    first.id,
    (value) =>
      value.childOrder > second.childOrder &&
      value.childOrder < parent.childOrder &&
      value.parentId === null,
  );
  source = await pickup('Drag first');
  const empty = page
    .getByRole('region', { name: 'Empty section', exact: true })
    .locator('ul')
    .first();
  target = await empty.boundingBox();
  assert(target && target.height >= 48);
  await page.mouse.move(source.x, target.y + target.height / 2, { steps: 12 });
  assert((await empty.getAttribute('class')).includes('bg-accent/10'));
  await page.mouse.up();
  await preview().waitFor({ state: 'hidden' });
  await saved(first.id, (value) => value.sectionId === b && value.parentId === null);
  const beforeCancel = await read(first.id);
  await pickup('Drag first');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await preview().waitFor({ state: 'hidden' });
  assert.equal((await read(first.id)).childOrder, beforeCancel.childOrder);
  source = await pickup('Drag first');
  await page.mouse.move(1278, source.y, { steps: 10 });
  await page.mouse.up();
  await preview().waitFor({ state: 'hidden' });
  assert.equal((await read(first.id)).sectionId, b);
  assert.equal((await read(first.id)).childOrder, beforeCancel.childOrder);
  const keyboard = row('Keyboard one').getByRole('button', {
    name: 'Drag to reorder',
    exact: true,
  });
  await keyboard.focus();
  await page.keyboard.press('Space');
  await preview().waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await preview().waitFor({ state: 'hidden' });
  await saved(
    keyboardOne.id,
    (value) => value.childOrder > keyboardTwo.childOrder && value.sectionId === c,
  );
  source = await pickup('Nested child');
  await page.mouse.move(source.x - 60, source.y, { steps: 10 });
  await page.mouse.up();
  await preview().waitFor({ state: 'hidden' });
  await saved(
    child.id,
    (value) =>
      value.parentId === null && value.sectionId === a && value.childOrder > parent.childOrder,
  );
  await page.reload();
  await row('Nested child').waitFor();
  assert.equal((await read(first.id)).sectionId, b);
  await post('/api/v1/sync', {
    cursor: null,
    commands: [{ type: 'project_archive', uuid: randomUUID(), args: { id: project.id } }],
  });
  await page.waitForFunction(
    () =>
      ![...globalThis.document.querySelectorAll('button')].some(
        (element) => element.getAttribute('aria-label') === 'Drag to reorder',
      ),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: neutral completed dates, open overdue urgency, independent/persisted habit panels and check-ins, pointer/keyboard list pickup/drop/reorder/outdent/cancel/read-only behavior',
  );
} finally {
  await browser.close();
}
