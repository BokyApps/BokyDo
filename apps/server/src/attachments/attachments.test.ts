import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { grantProjectAccess } from '../sync/membership.js';
import { cleanFilename, sniff } from './store.js';

let t: TestApp;
const u: Record<string, { sync: SyncUser; http: Client; id: string }> = {};
let project: string;
let task: string;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 1),
]);
const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>');

async function user(name: string) {
  const userId = await createUser(t.db, { username: name, password: 'x'.repeat(12) });
  const http = new Client(t.app);
  const { token, session } = await t.app.services.sessions.create(
    { id: userId, username: name, isAdmin: false, mustChangePassword: false },
    { ip: null, userAgent: null, authMethod: 'password' },
  );
  http.cookies.set('bokydo_session', token);
  http.csrfToken = session.csrfToken;
  const sync = new SyncUser(t.app.services.sync, userId);
  await sync.run();
  u[name] = { sync, http, id: userId };
}

async function upload(
  who: string,
  body: Buffer,
  opts: { projectId?: string; filename?: string; type?: string } = {},
) {
  const res = await u[who]!.http.request({
    method: 'POST',
    url: `/api/v1/projects/${opts.projectId ?? project}/attachments`,
    headers: {
      'content-type': opts.type ?? 'application/octet-stream',
      'x-filename': encodeURIComponent(opts.filename ?? 'file.bin'),
    },
    payload: body,
  });
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  };
}

const get = (who: string, attachmentId: string, inline = false) =>
  u[who]!.http.request({
    method: 'GET',
    url: `/api/v1/attachments/${attachmentId}${inline ? '?inline=1' : ''}`,
  });

beforeEach(async () => {
  if (!TEST_DATABASE_URL) return;
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  for (const name of ['owner', 'commenter', 'viewer', 'outsider']) await user(name);
  project = id();
  task = id();
  await u.owner!.sync.ok(
    cmd('project_add', { id: project, name: 'Launch' }),
    cmd('task_add', { id: task, projectId: project, content: 'Mockups' }),
  );
  await grantProjectAccess(t.db.db, project, u.commenter!.id, 'commenter');
  await grantProjectAccess(t.db.db, project, u.viewer!.id, 'viewer');
  for (const x of Object.values(u)) await x.sync.run();
});
afterEach(async () => t?.close());

describe('file helpers', () => {
  it('detects types from bytes only', () => {
    expect(sniff(PNG)).toEqual({ type: 'image/png', inline: true });
    expect(sniff(HTML)).toEqual({ type: 'application/octet-stream', inline: false });
    expect(sniff(Buffer.from('%PDF-1.7'))).toEqual({ type: 'application/pdf', inline: false });
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toMatchObject({
      inline: false,
    });
  });

  it.each([
    ['../../etc/passwd', '_.._etc_passwd'],
    ['report%0d%0aSet-Cookie: x=1.pdf', 'report__Set-Cookie: x=1.pdf'],
    ['%E0%A4%A', 'file'],
    ['', 'file'],
    ['...', 'file'],
    ['naïve résumé.txt', 'naïve résumé.txt'],
  ])('cleans %j', (raw, expected) => {
    expect(cleanFilename(encodeURIComponent(raw).replace(/%25/g, '%'))).toBe(expected);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('attachments (security gate)', () => {
  it('lets commenters upload, detecting the type from the bytes', async () => {
    const png = await upload('commenter', PNG, { filename: 'shot.png' });
    expect(png).toMatchObject({
      status: 201,
      body: { contentType: 'image/png', size: PNG.length, filename: 'shot.png' },
    });
    // A file claiming to be an image is still just bytes.
    const html = await upload('commenter', HTML, { filename: 'evil.png' });
    expect(html.body.contentType).toBe('application/octet-stream');
  });

  it.each([
    ['viewer', 403],
    ['outsider', 404],
  ])('refuses uploads from %s (%i)', async (who, status) => {
    expect((await upload(who, PNG)).status).toBe(status);
  });

  it('enforces size, emptiness, media type and the off switch', async () => {
    await t.app.services.settings.update(
      { 'attachments.maxSizeMb': 1 },
      { userId: null, ip: null },
    );
    expect((await upload('owner', Buffer.alloc(1024 * 1024 + 1))).status).toBe(413);
    expect((await upload('owner', Buffer.alloc(0))).status).toBe(400);
    // Anything but raw bytes is refused (by the body parser or by the route).
    for (const type of ['text/plain', 'application/json', 'multipart/form-data; boundary=x'])
      expect((await upload('owner', PNG, { type })).status).toBe(415);
    await t.app.services.settings.update(
      { 'attachments.maxSizeMb': 0 },
      { userId: null, ip: null },
    );
    expect((await upload('owner', PNG)).status).toBe(403);
  });

  it('keeps pending uploads private until a comment claims them', async () => {
    const { body } = await upload('commenter', PNG);
    const fileId = body.id as string;
    expect((await get('commenter', fileId)).statusCode).toBe(200);
    expect((await get('owner', fileId)).statusCode).toBe(404);

    // Nobody else can claim it, and it can't move to another project.
    expect(
      await u.owner!.sync.result(
        cmd('comment_add', { id: id(), taskId: task, content: 'mine', attachmentIds: [fileId] }),
      ),
    ).toMatchObject({ ok: false, error: 'invalid' });
    const other = id();
    await u.commenter!.sync.run();
    await u.owner!.sync.ok(cmd('project_add', { id: other, name: 'Other' }));
    await grantProjectAccess(t.db.db, other, u.commenter!.id, 'editor');
    expect(
      await u.commenter!.sync.result(
        cmd('comment_add', { id: id(), projectId: other, content: 'x', attachmentIds: [fileId] }),
      ),
    ).toMatchObject({ ok: false, error: 'invalid' });

    const commentId = id();
    await u.commenter!.sync.ok(
      cmd('comment_add', { id: commentId, taskId: task, content: '', attachmentIds: [fileId] }),
    );
    // A claimed upload can't be attached twice.
    expect(
      await u.commenter!.sync.result(
        cmd('comment_add', { id: id(), taskId: task, content: 'again', attachmentIds: [fileId] }),
      ),
    ).toMatchObject({ ok: false, error: 'invalid' });

    await u.viewer!.sync.run();
    expect(u.viewer!.sync.comments.get(commentId)?.attachments).toEqual([
      { id: fileId, filename: 'file.bin', contentType: 'image/png', size: PNG.length },
    ]);
    const res = await get('viewer', fileId);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
    });
    expect(res.headers['content-disposition']).toMatch(/^attachment; /);
    expect((await get('viewer', fileId, true)).headers['content-disposition']).toMatch(/^inline; /);
    expect((await get('outsider', fileId)).statusCode).toBe(404);
  });

  it('never serves unknown types inline', async () => {
    const { body } = await upload('owner', HTML, { filename: 'page.html' });
    await u.owner!.sync.ok(
      cmd('comment_add', {
        id: id(),
        taskId: task,
        content: 'x',
        attachmentIds: [body.id as string],
      }),
    );
    const res = await get('owner', body.id as string, true);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="download"; filename\*=UTF-8''page\.html$/,
    );
  });

  it('cuts off removed members and deleted comments, and purges files', async () => {
    const { body } = await upload('owner', PNG);
    const fileId = body.id as string;
    const commentId = id();
    await u.owner!.sync.ok(
      cmd('comment_add', { id: commentId, taskId: task, content: 'x', attachmentIds: [fileId] }),
    );
    expect((await get('viewer', fileId)).statusCode).toBe(200);
    await u.owner!.sync.ok(
      cmd('project_member_remove', { projectId: project, userId: u.viewer!.id }),
    );
    expect((await get('viewer', fileId)).statusCode).toBe(404);

    await u.owner!.sync.ok(cmd('comment_delete', { id: commentId }));
    expect((await get('owner', fileId)).statusCode).toBe(404);
    await t.app.services.purgeAttachments!();
    expect(await readdir(`${t.dataDir}/attachments`)).not.toContain(fileId);
  });
});
