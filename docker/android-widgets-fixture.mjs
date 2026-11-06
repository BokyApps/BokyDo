/** Seed only a FRESH throwaway loopback instance for WidgetsDeviceTest. Never print its token. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const { request } = createRequire(import.meta.url)('playwright-core');
const base = process.env.BOKYDO_TEST_BASE_URL;
const output = process.env.BOKYDO_WIDGET_FIXTURE_PATH;
assert(base && ['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert(output, 'Set BOKYDO_WIDGET_FIXTURE_PATH to a private temporary file');
const api = await request.newContext();
try {
  assert(
    (await (await api.get(`${base}/api/v1/instance`)).json()).initialAdminRequired,
    'Refusing initialized instance',
  );
  const signup = await api.post(`${base}/api/v1/setup/admin`, {
    headers: { origin: base },
    data: { username: 'widget-fixture', password: 'violin-pancake-orbit-meadow' },
  });
  assert.equal(signup.status(), 201);
  const headers = { origin: base, 'x-csrf-token': (await signup.json()).csrfToken };
  const post = async (path, data) => {
    const response = await api.post(`${base}${path}`, { headers, data });
    assert(response.ok(), `${path}: ${response.status()}`);
    const body = await response.text();
    return body ? JSON.parse(body) : null;
  };
  assert(
    (await api.put(`${base}/api/v1/setup/public-url`, { headers, data: { publicUrl: base } })).ok(),
  );
  await post('/api/v1/setup/complete');
  const project = (await post('/api/v1/projects', { name: 'Widget project' })).project;
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 172800000).toISOString().slice(0, 10);
  for (const [content, date, projectId] of [
    ['Inbox fixture', null, undefined],
    ['Today fixture', today, undefined],
    ['Upcoming fixture', future, undefined],
    ['Project fixture', null, project.id],
  ]) {
    await post('/api/v1/tasks', {
      content,
      projectId,
      ...(date
        ? { due: { date, time: null, timezone: null, string: date, recurrence: null } }
        : {}),
    });
  }
  const habit = (
    await post('/api/v1/habits', { name: 'Daily widget habit', period: 'day', target: 1 })
  ).habit;
  await post('/api/v1/habits', { name: 'Weekly widget habit', period: 'week', target: 3 });
  const token = (
    await post('/api/v1/account/tokens', {
      name: 'Disposable emulator fixture',
      scopes: ['sync'],
      expiresInDays: 1,
    })
  ).token;
  const discovery = await (await api.get(`${base}/.well-known/bokydo`)).json();
  await writeFile(
    output,
    JSON.stringify({
      session: {
        origin: base,
        discovery,
        accessToken: token,
        refreshToken: 'disposable-test-no-refresh',
        accessExpiresAtMs: Date.now() + 3600000,
        scope: 'sync',
      },
      habitId: habit.id,
      projectId: project.id,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    'Disposable widget fixture created. Delete the stack and private fixture after testing.',
  );
} finally {
  await api.dispose();
}
