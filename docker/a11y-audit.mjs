/* global document, window, axe, getComputedStyle, innerWidth, innerHeight */
/* eslint-disable @typescript-eslint/no-unused-expressions --
   The checks read as `condition ? ok(…) : problem(…)`; this is a test script, not app code. */
/**
 * Accessibility audit of a running BokyDo (WCAG 2.2 AA). Run it again after big UI changes.
 *
 * It drives headless Chrome through the real app and checks what can be checked mechanically:
 *  - axe-core (WCAG 2.0/2.1/2.2 A and AA, plus best practices) on every main screen, menu and
 *    dialog, in light and dark, at desktop and phone width, and on the admin pages;
 *  - keyboard use: every tab stop has a visible, unobscured focus indicator and a name, no
 *    keyboard traps, dialogs take and return focus, the page title and focus follow navigation,
 *    single-key shortcuts can be turned off, dragging has non-drag alternatives and named
 *    announcements;
 *  - reflow at 320 CSS px (400% zoom) and the WCAG text-spacing overrides.
 * It cannot replace testing with a real screen reader and real assistive technology.
 *
 *   mkdir /tmp/a11y && cd /tmp/a11y && npm i playwright-core axe-core
 *   A11Y_BASE=http://127.0.0.1:18080 A11Y_USER=alice A11Y_PASSWORD=… \
 *     [A11Y_ADMIN_PASSWORD=…] [A11Y_CHROME=/usr/bin/google-chrome] \
 *     node /path/to/docker/a11y-audit.mjs
 *
 * Use a throwaway stack (docker/smoke-test.sh with KEEP=1, or compose.yml with docker/
 * compose.smoke.yml): the audit creates a project, tasks and a saved filter for its user, and
 * briefly switches that user's single-key shortcuts off and on again.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'noop.js'));
const { chromium } = require('playwright-core');
const axeSource = (await import('node:fs')).readFileSync(
  require.resolve('axe-core/axe.min.js'),
  'utf8',
);

const BASE = (process.env.A11Y_BASE ?? 'http://127.0.0.1:18080').replace(/\/$/, '');
const USER = process.env.A11Y_USER;
const PASSWORD = process.env.A11Y_PASSWORD;
const ADMIN_PASSWORD = process.env.A11Y_ADMIN_PASSWORD;
const CHROME = process.env.A11Y_CHROME ?? '/usr/bin/google-chrome';
if (!USER || !PASSWORD) {
  console.error('Set A11Y_USER and A11Y_PASSWORD (and A11Y_BASE if not on :18080).');
  process.exit(2);
}

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const problems = [];
const problem = (area, message) => {
  problems.push(`${area}: ${message}`);
  console.log(`  ✗ ${area}: ${message}`);
};
const ok = (message) => console.log(`  ✓ ${message}`);

/** Sign in over the API (the browser context keeps the cookies) and return the CSRF token. */
async function signIn(page, username, password) {
  const res = await page.request.post(`${BASE}/api/v1/auth/login`, {
    headers: { origin: BASE },
    data: { username, password },
  });
  if (!res.ok()) throw new Error(`Sign-in as ${username} failed (${res.status()}).`);
  return (await res.json()).csrfToken;
}

/** A project with a section, a spread of tasks and a saved filter, so every view has content. */
async function seed(page, csrf) {
  const id = () => randomUUID();
  const due = (date, time = null, recurrence = null) => ({
    date,
    time,
    timezone: null,
    string: date,
    recurrence,
  });
  const project = id();
  const section = id();
  const filter = id();
  const task = (content, over = {}) => ({
    type: 'task_add',
    uuid: id(),
    args: { id: id(), projectId: project, sectionId: section, childOrder: 'a0', content, ...over },
  });
  const commands = [
    { type: 'project_add', uuid: id(), args: { id: project, name: 'Accessibility audit' } },
    {
      type: 'section_add',
      uuid: id(),
      args: { id: section, projectId: project, name: 'Section', sectionOrder: 'a0' },
    },
    task('Plan the week', {
      priority: 1,
      due: due('2030-03-01'),
      description: 'See [the docs](https://example.com/docs).',
    }),
    task('Call the nursery', {
      due: due('2030-03-04', '09:30'),
      durationMinutes: 30,
      labels: ['errand'],
    }),
    task('Water the beds', {
      due: due('2030-03-04', null, { rrule: 'FREQ=WEEKLY;BYDAY=MO', anchor: 'scheduled' }),
    }),
    task('Write the report', { priority: 2 }),
    { type: 'filter_add', uuid: id(), args: { id: filter, name: 'Urgent', query: 'p1' } },
  ].map((c, i) => (c.type === 'task_add' ? { ...c, args: { ...c.args, childOrder: `a${i}` } } : c));
  const res = await page.request.post(`${BASE}/api/v1/sync`, {
    headers: { origin: BASE, 'x-csrf-token': csrf },
    data: { cursor: null, commands },
  });
  if (!res.ok()) throw new Error(`Seeding failed (${res.status()}).`);
  return { project, filter };
}

async function scanAxe(page, name, found) {
  await page.waitForTimeout(600);
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(
    (tags) =>
      axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }),
    TAGS,
  );
  for (const v of result.violations) {
    // A menu that is open covers whatever is under it: not a target-size problem for the user.
    const nodes = v.nodes.filter(
      (n) =>
        !(
          v.id === 'target-size' &&
          ((n.any[0] ?? n.all[0] ?? n.none[0] ?? {}).message ?? '').includes('partially obscured')
        ),
    );
    if (nodes.length === 0) continue;
    found.push(
      `${name}: ${v.id} (${v.impact}) ${v.help}: ${nodes
        .slice(0, 2)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
    );
  }
}

async function axePass({ browser, project, filter, csrfOf }) {
  console.log('\n[axe] WCAG 2.2 AA + best practices');
  const found = [];
  let scans = 0;
  const scan = async (page, name) => {
    scans++;
    await scanAxe(page, name, found);
  };
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 1280, height: 900 },
      bypassCSP: true,
    });
    const page = await ctx.newPage();
    await csrfOf(page, USER, PASSWORD);
    const tag = (n) => `${n} [${scheme}]`;
    for (const [url, name] of [
      ['/today', 'Today'],
      ['/inbox', 'Inbox'],
      ['/upcoming', 'Upcoming'],
      ['/completed', 'Completed'],
      ['/filters-labels', 'Filters & Labels'],
      ['/templates', 'Templates'],
      [`/project/${project}`, 'Project (list)'],
      [`/filter/${filter}`, 'Filter page'],
      ['/archived', 'Archived'],
      ['/account/security', 'Account security'],
      ['/settings', 'Settings: appearance'],
      ['/settings/notifications', 'Settings: notifications'],
      ['/settings/calendar', 'Settings: calendar'],
      ['/settings/apps', 'Settings: apps & tokens'],
      ['/settings/data', 'Settings: your data'],
    ]) {
      await page.goto(BASE + url);
      await scan(page, tag(name));
    }
    // The delete-account dialog (opened, scanned, cancelled: nothing is deleted).
    await page.goto(`${BASE}/settings/data`);
    await page.getByRole('button', { name: 'Delete my account…' }).click();
    await scan(page, tag('Dialog: delete account'));
    await page.keyboard.press('Escape');
    await page.goto(`${BASE}/settings`);
    await page.getByRole('tab', { name: 'general' }).click();
    await scan(page, tag('Settings: general'));
    await page.goto(`${BASE}/today`);
    for (const [key, name] of [
      ['q', 'Quick add'],
      ['/', 'Search'],
      ['?', 'Shortcuts help'],
    ]) {
      await page.keyboard.press(key);
      await scan(page, tag(`${name} dialog`));
      await page.keyboard.press('Escape');
    }
    await page.goto(`${BASE}/project/${project}`);
    await page.waitForTimeout(500);
    await page.getByText('Plan the week').first().click();
    await scan(page, tag('Task detail dialog'));
    await page.keyboard.press('Escape');
    for (const layout of ['Board', 'Calendar', 'List']) {
      await page.goto(`${BASE}/project/${project}`);
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: 'View', exact: true }).click();
      await page.getByRole('button', { name: layout, exact: true }).click();
      await page.keyboard.press('Escape');
      await scan(page, tag(`Project (${layout.toLowerCase()})`));
    }
    await page.goto(`${BASE}/project/${project}`);
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /account menu/i }).click();
    await scan(page, tag('Account menu'));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await scan(page, tag('Notifications panel'));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Project actions' }).click();
    await scan(page, tag('Project menu'));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await scan(page, tag('Share dialog'));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add project' }).click();
    await scan(page, tag('New project dialog'));
    await page.keyboard.press('Escape');
    await page.locator('[data-task-row]').first().hover();
    await page.getByRole('button', { name: 'More actions' }).first().click();
    await scan(page, tag('Task menu'));
    await ctx.close();
  }
  const phone = await browser.newContext({
    viewport: { width: 375, height: 812 },
    bypassCSP: true,
  });
  const pp = await phone.newPage();
  await csrfOf(pp, USER, PASSWORD);
  for (const [url, name] of [
    ['/today', 'Today'],
    [`/project/${project}`, 'Project'],
    ['/upcoming', 'Upcoming'],
    ['/templates', 'Templates'],
    ['/settings/calendar', 'Settings: calendar'],
    ['/settings/data', 'Settings: your data'],
  ]) {
    await pp.goto(BASE + url);
    await scan(pp, `${name} [phone]`);
  }
  await phone.close();
  if (ADMIN_PASSWORD) {
    const adminCtx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      bypassCSP: true,
    });
    const ap = await adminCtx.newPage();
    await csrfOf(ap, 'admin', ADMIN_PASSWORD);
    for (const [url, name] of [
      ['/admin/users', 'Admin: users'],
      ['/admin/settings', 'Admin: settings'],
      ['/admin/backups', 'Admin: backups'],
    ]) {
      await ap.goto(BASE + url);
      await scan(ap, name);
    }
    await adminCtx.close();
  }
  const out = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
  const lp = await out.newPage();
  await lp.goto(`${BASE}/login`);
  await scan(lp, 'Sign-in (signed out)');
  await out.close();
  for (const f of found) problem('axe', f);
  if (found.length === 0) ok(`${scans} screens and states scanned: no violations`);
}

/** The focused element: where it is, what it is called, and whether anything covers it. */
const describeFocus = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const r = el.getBoundingClientRect();
  const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
    .split(' ')
    .map((i) => document.getElementById(i)?.textContent ?? '')
    .join(' ')
    .trim();
  const name =
    el.getAttribute('aria-label') ||
    labelledBy ||
    (el.innerText || el.value || el.labels?.[0]?.textContent || el.getAttribute('title') || '')
      .trim()
      .slice(0, 40);
  const tiny = r.width <= 2 || r.height <= 2;
  const label = el.closest('label');
  const top = document.elementFromPoint(
    Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1),
    Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1),
  );
  return {
    tag: el.tagName.toLowerCase(),
    name,
    tiny,
    labelRing: label ? getComputedStyle(label).outlineStyle !== 'none' : false,
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    covered: !tiny && !!top && top !== el && !el.contains(top) && !top.contains(el),
  };
};

async function tabAudit(page, label, max = 80) {
  console.log(`\n[${label}] tab order`);
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await page.keyboard.press('Tab');
  const seen = new Set();
  let stops = 0;
  let looped = false;
  const before = problems.length;
  for (let i = 0; i < max; i++) {
    const d = await page.evaluate(describeFocus);
    if (!d) break;
    const key = `${d.tag}|${d.name}|${Math.round(d.rect.x)}|${Math.round(d.rect.y)}`;
    if (seen.has(key)) {
      looped = true;
      break;
    }
    seen.add(key);
    stops++;
    if (d.tiny) {
      if (!d.labelRing)
        problem(label, `visually hidden <${d.tag}> "${d.name}" shows no focus ring on its label`);
    } else {
      const clip = {
        x: Math.max(d.rect.x - 4, 0),
        y: Math.max(d.rect.y - 4, 0),
        width: Math.min(d.rect.w + 8, 1200),
        height: Math.min(d.rect.h + 8, 300),
      };
      const focused = await page.screenshot({ clip });
      await page.evaluate(() => {
        window.__focused = document.activeElement;
        document.activeElement?.blur();
      });
      const blurred = await page.screenshot({ clip });
      await page.evaluate(() => window.__focused?.focus());
      if (focused.equals(blurred))
        problem(label, `no visible focus indicator on <${d.tag}> "${d.name}"`);
    }
    if (d.covered) problem(label, `focused <${d.tag}> "${d.name}" is covered by another element`);
    if (!d.name) problem(label, `focusable <${d.tag}> has no accessible name`);
    await page.keyboard.press('Tab');
  }
  if (!looped && stops >= max)
    problem(label, 'tab order never left the page (possible keyboard trap)');
  if (problems.length === before) ok(`${stops} tab stops: all visible, unobscured and named`);
}

async function keyboardPass({ browser, project, csrfOf }) {
  console.log('\n[keyboard] focus, navigation, dialogs, dragging, shortcuts');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
  const page = await ctx.newPage();
  await csrfOf(page, USER, PASSWORD);
  const open = async (url) => {
    await page.goto(BASE + url);
    await page.waitForTimeout(700);
  };
  const setLayout = async (layout) => {
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByRole('button', { name: layout, exact: true }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  };

  for (const [url, name] of [
    ['/today', 'Today'],
    [`/project/${project}`, 'Project'],
    ['/upcoming', 'Upcoming'],
    ['/templates', 'Templates'],
    ['/settings/calendar', 'Settings: calendar'],
    ['/completed', 'Completed'],
  ]) {
    await open(url);
    await tabAudit(page, name);
  }
  for (const layout of ['Board', 'Calendar']) {
    await open(`/project/${project}`);
    await setLayout(layout);
    await tabAudit(page, `Project (${layout.toLowerCase()})`, 100);
  }
  await open(`/project/${project}`);
  await setLayout('Board');
  const handles = await page.getByRole('button', { name: /^Move “/ }).count();
  handles > 0
    ? ok(`${handles} board cards each have a named move handle`)
    : problem('board', 'no move handles on board cards');
  await open(`/project/${project}`);
  await setLayout('List');

  console.log('\n[navigation] titles and focus');
  await open('/today');
  for (const link of ['Inbox', 'Upcoming', 'Completed', 'Templates']) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await page.waitForTimeout(500);
    const title = await page.title();
    const focus = await page.evaluate(
      () => document.activeElement?.id || document.activeElement?.tagName,
    );
    if (!title.startsWith(link)) problem('titles', `${link}: the title is "${title}"`);
    else if (focus !== 'main')
      problem('titles', `${link}: focus is on ${focus}, not on the main region`);
    else ok(`${link}: title "${title}" and focus on main`);
  }
  await page.keyboard.press('Tab');
  (await page.evaluate(() => !!document.activeElement?.closest('main')))
    ? ok('Tab after navigating lands inside the new page')
    : problem('navigation', 'Tab after navigation did not land inside main');

  console.log('\n[dialogs] focus handling');
  await open('/today');
  await page.keyboard.press('q');
  await page.waitForTimeout(300);
  (await page.evaluate(() => !!document.activeElement?.closest('dialog[open]')))
    ? ok('quick add opens with focus inside the dialog')
    : problem('dialogs', 'focus is not inside the quick-add dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  (await page.evaluate(() => !document.querySelector('dialog[open]')))
    ? ok('Escape closes it')
    : problem('dialogs', 'Escape did not close the dialog');
  await open(`/project/${project}`);
  await page.locator('[data-task-row]').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  (await page.evaluate(() => !!document.querySelector('dialog[open]')))
    ? ok('Enter on a task row opens it')
    : problem('dialogs', 'Enter on a task row did not open it');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  (await page.evaluate(() => !!document.activeElement?.closest('[data-task-row]')))
    ? ok('focus returns to the task row afterwards')
    : problem('dialogs', 'focus did not return to the task row');
  await page.locator('[data-task-row]').first().hover();
  await page.getByRole('button', { name: 'More actions' }).first().click();
  await page.keyboard.press('Escape');
  (await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'More actions'))
    ? ok('closing a menu returns focus to its button')
    : problem('dialogs', 'closing a menu did not return focus to its button');

  console.log('\n[dragging] alternatives (WCAG 2.5.7)');
  await open(`/project/${project}`);
  const titles = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-task-row] [id$="-title"]')].map((e) =>
        e.textContent.trim(),
      ),
    );
  const first = await titles();
  await page.locator('[data-task-row]').first().hover();
  await page.getByRole('button', { name: 'More actions' }).first().click();
  const down = page.getByRole('button', { name: 'Move down', exact: true });
  if ((await down.count()) === 0) problem('dragging', 'the task menu has no "Move down"');
  else {
    await down.click();
    await page.waitForTimeout(700);
    const after = await titles();
    after[1] === first[0]
      ? ok('"Move down" reorders without dragging')
      : problem('dragging', 'Move down did not move the task');
  }
  await page.locator('[aria-label="Drag to reorder"]').first().focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  const live = await page.evaluate(() =>
    [...document.querySelectorAll('[id^="DndLiveRegion"]')]
      .map((e) => e.textContent)
      .join(' ')
      .trim(),
  );
  await page.keyboard.press('Space');
  if (!live) problem('dragging', 'no announcement while dragging by keyboard');
  else if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(live))
    problem('dragging', `the announcement reads out an id: "${live.slice(0, 90)}"`);
  else ok(`dragging by keyboard is announced in words: "${live.slice(0, 80)}"`);

  console.log('\n[shortcuts] single-key shortcuts can be turned off (WCAG 2.1.4)');
  await open('/settings');
  await page.getByRole('tab', { name: 'general' }).click();
  const box = page.getByLabel('Single-key keyboard shortcuts');
  if ((await box.count()) === 0) problem('shortcuts', 'no setting found');
  else {
    await box.uncheck();
    await page.waitForTimeout(800);
    await open('/today');
    await page.keyboard.press('q');
    await page.waitForTimeout(300);
    (await page.evaluate(() => !document.querySelector('dialog[open]')))
      ? ok('q does nothing when shortcuts are off')
      : problem('shortcuts', 'q still opens quick add');
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(300);
    (await page.evaluate(() => !!document.querySelector('dialog[open]')))
      ? ok('Ctrl+K still opens search')
      : problem('shortcuts', 'Ctrl+K stopped working');
    await page.keyboard.press('Escape');
    await open('/settings');
    await page.getByRole('tab', { name: 'general' }).click();
    await page.getByLabel('Single-key keyboard shortcuts').check();
    await page.waitForTimeout(600);
  }
  await ctx.close();

  console.log('\n[reflow] 320 CSS px wide (400% zoom) and WCAG text spacing');
  const small = await browser.newContext({
    viewport: { width: 320, height: 640 },
    bypassCSP: true,
  });
  const sp = await small.newPage();
  await csrfOf(sp, USER, PASSWORD);
  for (const [url, name] of [
    ['/today', 'Today'],
    [`/project/${project}`, 'Project'],
    ['/upcoming', 'Upcoming'],
    ['/templates', 'Templates'],
    ['/settings', 'Settings'],
    ['/settings/calendar', 'Settings: calendar'],
  ]) {
    await sp.goto(BASE + url);
    await sp.waitForTimeout(700);
    const w = await sp.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: innerWidth,
    }));
    w.scroll > w.inner + 1
      ? problem('reflow', `${name}: the page scrolls sideways (${w.scroll}px in ${w.inner}px)`)
      : ok(`${name}: no sideways scrolling`);
    await sp.addStyleTag({
      content:
        '*{line-height:1.5 !important;letter-spacing:.12em !important;word-spacing:.16em !important} p{margin-bottom:2em !important}',
    });
    await sp.waitForTimeout(200);
    const clipped = await sp.evaluate(() =>
      [...document.querySelectorAll('main *, header *')]
        .filter((el) => {
          const s = getComputedStyle(el);
          return (
            (s.overflow === 'hidden' || s.overflowX === 'hidden') &&
            el.scrollWidth > el.clientWidth + 2 &&
            !s.textOverflow.includes('ellipsis') &&
            el.clientWidth > 2 &&
            !el.closest('.sr-only') &&
            el.children.length === 0 &&
            el.textContent.trim().length > 0
          );
        })
        .slice(0, 3)
        .map((el) => `${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 30)}"`),
    );
    if (clipped.length) problem('text spacing', `${name}: clipped text ${clipped.join(', ')}`);
  }
  await small.close();
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const setup = await browser.newContext({ bypassCSP: true });
  const sp = await setup.newPage();
  const csrf = await signIn(sp, USER, PASSWORD);
  const { project, filter } = await seed(sp, csrf);
  await setup.close();
  const csrfOf = (page, user, password) => signIn(page, user, password);
  await axePass({ browser, project, filter, csrfOf });
  await keyboardPass({ browser, project, csrfOf });
} finally {
  await browser.close();
}
console.log(
  problems.length === 0 ? '\nNo problems found.' : `\n${problems.length} problem(s) found.`,
);
process.exit(problems.length === 0 ? 0 : 1);
