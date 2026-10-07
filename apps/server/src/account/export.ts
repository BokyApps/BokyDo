import { writeCsv, type Task } from '@bokydo/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { AttachmentStore } from '../attachments/store.js';
import type { Database } from '../db/client.js';
import { aiCredentials, attachments, tasks, users } from '../db/schema.js';
import type { ApiTokenStore } from '../oauth/token-store.js';
import { visibleProjects } from '../sync/policy.js';
import { taskToWire } from '../sync/serialize.js';
import type { SyncService } from '../sync/sync-service.js';
import { safeEntryName, ZipWriter } from '../zip/zip-writer.js';

export interface ExportDeps {
  db: Database;
  sync: SyncService;
  store: AttachmentStore;
  tokens: ApiTokenStore;
  publicUrl: string | null;
}

/**
 * "Export everything" (GDPR data portability): everything the user can see, as one ZIP —
 * `export.json` (complete, machine-readable), `tasks.csv` (for spreadsheets; formula-guarded)
 * and the attachment files. Secrets are never included: no password hash, TOTP secret, passkey
 * keys, API keys or tokens, only their names and dates.
 */
export function buildExport(deps: ExportDeps, userId: string): ZipWriter {
  const zip = new ZipWriter();
  void (async () => {
    const snapshot = await deps.sync.read(userId, null);
    const visible = await deps.db.transaction((tx) => visibleProjects(tx, userId));
    const projectIds = [...visible.keys()];
    // The sync snapshot only carries recently completed tasks; the export has all of them.
    const allTasks: Task[] = projectIds.length
      ? (
          await deps.db
            .select()
            .from(tasks)
            .where(and(inArray(tasks.projectId, projectIds), isNull(tasks.deletedAt)))
            .orderBy(asc(tasks.projectId), asc(tasks.childOrder))
        ).map(taskToWire)
      : [];
    const [account] = await deps.db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        isAdmin: users.isAdmin,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId));
    const files = projectIds.length
      ? await deps.db
          .select()
          .from(attachments)
          .where(and(inArray(attachments.projectId, projectIds), isNull(attachments.deletedAt)))
      : [];
    const pats = await deps.tokens.listPats(userId);
    const apps = await deps.tokens.listApps(userId);
    const ai = await deps.db
      .select({
        id: aiCredentials.id,
        provider: aiCredentials.provider,
        label: aiCredentials.label,
        createdAt: aiCredentials.createdAt,
      })
      .from(aiCredentials)
      .where(eq(aiCredentials.ownerUserId, userId));

    const attachmentFile = (a: (typeof files)[number]) =>
      `attachments/${a.id}/${safeEntryName(a.filename).replace(/\//g, '_')}`;
    const data = {
      format: 'bokydo-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      instance: deps.publicUrl,
      account: account && {
        ...account,
        createdAt: account.createdAt.toISOString(),
        preferences: snapshot.user.preferences,
      },
      projects: snapshot.projects,
      sections: snapshot.sections,
      tasks: allTasks,
      labels: snapshot.labels,
      filters: snapshot.filters,
      comments: snapshot.comments,
      reminders: snapshot.reminders,
      collaborators: snapshot.collaborators,
      projectMembers: snapshot.members,
      workspaces: snapshot.workspaces,
      workspaceMembers: snapshot.workspaceMembers,
      folders: snapshot.folders,
      notifications: snapshot.notifications,
      attachments: files.map((a) => ({
        id: a.id,
        projectId: a.projectId,
        commentId: a.commentId,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        createdAt: a.createdAt.toISOString(),
        file: attachmentFile(a),
      })),
      personalAccessTokens: pats,
      connectedApps: apps,
      aiCredentials: ai.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
    };
    await zip.add(
      'README.txt',
      'Your BokyDo data.\n\n' +
        'export.json  everything, machine-readable (projects, tasks incl. completed, comments, labels, filters, reminders, teams, settings)\n' +
        'tasks.csv    your tasks for spreadsheets (cells that look like formulas start with an apostrophe)\n' +
        'attachments/ the files attached to comments\n\n' +
        'Passwords, two-factor secrets, passkeys, API keys and tokens are never exported.\n',
    );
    await zip.add('export.json', JSON.stringify(data, null, 2));
    await zip.add('tasks.csv', tasksCsv(allTasks, data));
    for (const a of files) {
      try {
        await zip.add(attachmentFile(a), deps.store.read(a.id), { date: a.createdAt });
      } catch {
        // A file missing on disk shouldn't sink the whole export; export.json still lists it.
      }
    }
    await zip.finish();
  })().catch((err: unknown) => zip.abort(err instanceof Error ? err : new Error('export failed')));
  return zip;
}

function tasksCsv(
  list: Task[],
  ctx: {
    projects: { id: string; name: string }[];
    sections: { id: string; name: string }[];
    collaborators: { id: string; username: string }[];
  },
): string {
  const project = new Map(ctx.projects.map((p) => [p.id, p.name]));
  const section = new Map(ctx.sections.map((s) => [s.id, s.name]));
  const person = new Map(ctx.collaborators.map((c) => [c.id, c.username]));
  const rows = [
    [
      'Project',
      'Section',
      'Task',
      'Description',
      'Priority',
      'Due',
      'Due date',
      'Deadline',
      'Labels',
      'Assignee',
      'Completed',
      'Completed at',
      'Created at',
    ],
    ...list.map((t) => [
      project.get(t.projectId) ?? '',
      t.sectionId ? (section.get(t.sectionId) ?? '') : '',
      t.content,
      t.description,
      `p${t.priority}`,
      t.due?.string ?? '',
      t.due ? `${t.due.date}${t.due.time ? ` ${t.due.time}` : ''}` : '',
      t.deadline ?? '',
      t.labels.join(', '),
      t.assigneeId ? (person.get(t.assigneeId) ?? '') : '',
      t.isCompleted ? 'yes' : 'no',
      t.completedAt ?? '',
      t.createdAt,
    ]),
  ];
  return writeCsv(rows);
}
