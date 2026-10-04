import type { Color, Filter, Label, Project, Role, Section, Task } from '@bokydo/shared';
import type { filters, labels, projects, sections, tasks } from '../db/schema.js';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export const projectToWire = (
  p: Row<typeof projects>,
  member: { role: Role; isFavorite: boolean },
): Project => ({
  id: p.id,
  name: p.name,
  color: p.color as Color,
  parentId: p.parentId,
  childOrder: p.childOrder,
  viewStyle: p.viewStyle as Project['viewStyle'],
  isInbox: p.isInbox,
  isArchived: p.isArchived,
  isFavorite: member.isFavorite,
  role: member.role,
  updatedAt: p.updatedAt.toISOString(),
});

export const sectionToWire = (s: Row<typeof sections>): Section => ({
  id: s.id,
  projectId: s.projectId,
  name: s.name,
  sectionOrder: s.sectionOrder,
  isArchived: s.isArchived,
  updatedAt: s.updatedAt.toISOString(),
});

export const taskToWire = (t: Row<typeof tasks>): Task => ({
  id: t.id,
  projectId: t.projectId,
  sectionId: t.sectionId,
  parentId: t.parentId,
  content: t.content,
  description: t.description,
  priority: t.priority,
  due: t.due ?? null,
  deadline: t.deadline,
  durationMinutes: t.durationMinutes,
  labels: t.labels,
  assigneeId: t.assigneeId,
  assignedById: t.assignedById,
  childOrder: t.childOrder,
  isCompleted: t.isCompleted,
  completedAt: t.completedAt?.toISOString() ?? null,
  createdById: t.createdById,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export const labelToWire = (l: Row<typeof labels>): Label => ({
  id: l.id,
  name: l.name,
  color: l.color as Color,
  itemOrder: l.itemOrder,
  isFavorite: l.isFavorite,
});

export const filterToWire = (f: Row<typeof filters>): Filter => ({
  id: f.id,
  name: f.name,
  query: f.query,
  color: f.color as Color,
  itemOrder: f.itemOrder,
  isFavorite: f.isFavorite,
});
