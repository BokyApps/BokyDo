import type { CommandArgs } from '@bokydo/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { sections, tasks } from '../../db/schema.js';
import { fail, LIMITS, type CommandContext } from '../context.js';
import { requireProject } from '../policy.js';
import { allOf, nextOrderKey } from './common.js';

type SectionRow = typeof sections.$inferSelect;

/** A live section in a project the user may edit. */
export async function requireSection(ctx: CommandContext, id: string): Promise<SectionRow> {
  const [section] = await ctx.tx
    .select()
    .from(sections)
    .where(and(eq(sections.id, id), isNull(sections.deletedAt)));
  if (!section) return fail('not_found', 'section');
  const project = await requireProject(ctx.tx, ctx.userId, section.projectId, 'edit');
  if (project.isArchived) fail('invalid', 'project is archived');
  return section;
}

const sectionsOf = (projectId: string) =>
  allOf(eq(sections.projectId, projectId), isNull(sections.deletedAt));

export async function sectionAdd(
  ctx: CommandContext,
  args: CommandArgs<'section_add'>,
): Promise<void> {
  const project = await requireProject(ctx.tx, ctx.userId, args.projectId, 'edit');
  if (project.isArchived) fail('invalid', 'project is archived');
  const [existing] = await ctx.tx
    .select({ n: count() })
    .from(sections)
    .where(sectionsOf(project.id));
  if ((existing?.n ?? 0) >= LIMITS.sectionsPerProject) fail('limit_exceeded', 'too many sections');
  const inserted = await ctx.tx
    .insert(sections)
    .values({
      id: args.id,
      projectId: project.id,
      name: args.name,
      sectionOrder:
        args.sectionOrder ??
        (await nextOrderKey(ctx.tx, sections, sections.sectionOrder, sectionsOf(project.id))),
    })
    .onConflictDoNothing()
    .returning({ id: sections.id });
  if (inserted.length === 0) fail('conflict', 'id already in use');
  ctx.changes.inProject('sections', args.id, project.id);
}

export async function sectionUpdate(
  ctx: CommandContext,
  args: CommandArgs<'section_update'>,
): Promise<void> {
  const section = await requireSection(ctx, args.id);
  await ctx.tx
    .update(sections)
    .set({ name: args.name, updatedAt: ctx.now })
    .where(eq(sections.id, section.id));
  ctx.changes.inProject('sections', section.id, section.projectId);
}

/** Move a section (and all of its tasks) within or to another project. */
export async function sectionMove(
  ctx: CommandContext,
  args: CommandArgs<'section_move'>,
): Promise<void> {
  const section = await requireSection(ctx, args.id);
  const toProject = args.projectId ?? section.projectId;
  if (toProject !== section.projectId) {
    const target = await requireProject(ctx.tx, ctx.userId, toProject, 'edit');
    if (target.isArchived) fail('invalid', 'project is archived');
  }
  await ctx.tx
    .update(sections)
    .set({
      projectId: toProject,
      sectionOrder:
        args.sectionOrder ??
        (await nextOrderKey(ctx.tx, sections, sections.sectionOrder, sectionsOf(toProject))),
      updatedAt: ctx.now,
    })
    .where(eq(sections.id, section.id));
  ctx.changes.inProject('sections', section.id, section.projectId);
  if (toProject !== section.projectId) {
    ctx.changes.inProject('sections', section.id, toProject);
    const moved = await ctx.tx
      .update(tasks)
      .set({ projectId: toProject, updatedAt: ctx.now })
      .where(and(eq(tasks.sectionId, section.id), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id });
    for (const t of moved) {
      ctx.changes.inProject('tasks', t.id, section.projectId);
      ctx.changes.inProject('tasks', t.id, toProject);
    }
  }
}

async function setArchived(ctx: CommandContext, id: string, isArchived: boolean): Promise<void> {
  const section = await requireSection(ctx, id);
  await ctx.tx
    .update(sections)
    .set({ isArchived, updatedAt: ctx.now })
    .where(eq(sections.id, section.id));
  ctx.changes.inProject('sections', section.id, section.projectId);
}
export const sectionArchive = (ctx: CommandContext, a: CommandArgs<'section_archive'>) =>
  setArchived(ctx, a.id, true);
export const sectionUnarchive = (ctx: CommandContext, a: CommandArgs<'section_unarchive'>) =>
  setArchived(ctx, a.id, false);

/** Deleting a section deletes its tasks (as in Todoist). */
export async function sectionDelete(
  ctx: CommandContext,
  args: CommandArgs<'section_delete'>,
): Promise<void> {
  const section = await requireSection(ctx, args.id);
  await ctx.tx
    .update(sections)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(sections.id, section.id));
  ctx.changes.inProject('sections', section.id, section.projectId);
  const removed = await ctx.tx
    .update(tasks)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(tasks.sectionId, section.id), isNull(tasks.deletedAt)))
    .returning({ id: tasks.id });
  for (const t of removed) ctx.changes.inProject('tasks', t.id, section.projectId);
}
