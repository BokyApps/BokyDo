import { parseFilter } from '@bokydo/filter-query';
import { localNow, parseRRule } from '@bokydo/nlp';
import { z } from 'zod';
import { isValidOrderKey } from './ordering.js';
import { preferencesPatchSchema, type Preferences } from './preferences.js';

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

export const idSchema = z.uuid();
export const orderKeySchema = z.string().max(64).refine(isValidOrderKey, 'Invalid order key');

export const COLORS = [
  'berry_red',
  'red',
  'orange',
  'yellow',
  'olive_green',
  'lime_green',
  'green',
  'mint_green',
  'teal',
  'sky_blue',
  'light_blue',
  'blue',
  'grape',
  'violet',
  'lavender',
  'magenta',
  'salmon',
  'charcoal',
  'grey',
  'taupe',
] as const;
export const colorSchema = z.enum(COLORS);
export type Color = z.infer<typeof colorSchema>;

export const viewStyleSchema = z.enum(['list', 'board', 'calendar']);
export const roleSchema = z.enum(['owner', 'admin', 'editor', 'commenter', 'viewer']);
export type Role = z.infer<typeof roleSchema>;

/** p1 (most urgent) … p4 (default), as written in quick add. */
export const prioritySchema = z.number().int().min(1).max(4);

const dateString = z.iso.date();
const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');

// Deliberately matching control characters: user text must not smuggle them into logs, emails or
// notifications. Single-line text allows none; multi-line text allows tab, LF and CR.
// eslint-disable-next-line no-control-regex
const SINGLE_LINE = /^[^\u0000-\u001f\u007f]*$/;
// eslint-disable-next-line no-control-regex
const MULTI_LINE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

const line = (max: number) =>
  z.string().trim().min(1).max(max).regex(SINGLE_LINE, 'Must be a single line of text');

const text = (max: number) => z.string().max(max).regex(MULTI_LINE, 'Invalid characters');

export const labelNameSchema = line(60).refine(
  (v) => !/[\s@#]/.test(v),
  'Label names cannot contain spaces, @ or #',
);

/**
 * A due date. Date-only, or date + time that is either floating (shown in each viewer's time zone)
 * or fixed to an IANA time zone. `recurrence.rrule` is the subset of RFC 5545
 * that @bokydo/nlp supports (`parseRRule`); `date` is the series' current occurrence.
 */
export const dueSchema = z
  .object({
    date: dateString,
    time: timeString.nullable(),
    timezone: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9_+/-]+$/)
      .nullable(),
    string: line(200),
    recurrence: z
      .object({
        rrule: z
          .string()
          .max(500)
          .regex(/^[A-Z0-9=;,:+-]+$/, 'Invalid RRULE')
          .refine((v) => parseRRule(v) !== null, 'Unsupported recurrence rule'),
        anchor: z.enum(['scheduled', 'completion']),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type Due = z.infer<typeof dueSchema>;

// ---------------------------------------------------------------------------------------------
// Entities as clients see them
// ---------------------------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  color: Color;
  parentId: string | null;
  childOrder: string;
  viewStyle: z.infer<typeof viewStyleSchema>;
  isInbox: boolean;
  isArchived: boolean;
  /** Per user. */
  isFavorite: boolean;
  /** The current user's role in this project. */
  role: Role;
  updatedAt: string;
}

export interface Section {
  id: string;
  projectId: string;
  name: string;
  sectionOrder: string;
  isArchived: boolean;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  sectionId: string | null;
  parentId: string | null;
  content: string;
  description: string;
  priority: number;
  due: Due | null;
  deadline: string | null;
  durationMinutes: number | null;
  labels: string[];
  assigneeId: string | null;
  assignedById: string | null;
  childOrder: string;
  isCompleted: boolean;
  completedAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  id: string;
  name: string;
  color: Color;
  itemOrder: string;
  isFavorite: boolean;
}

export interface Filter {
  id: string;
  name: string;
  query: string;
  color: Color;
  itemOrder: string;
  isFavorite: boolean;
}

export interface SyncUser {
  id: string;
  username: string;
  isAdmin: boolean;
  inboxProjectId: string;
  preferences: Preferences;
}

/** Someone you share at least one project with (yourself included). */
export interface Collaborator {
  id: string;
  username: string;
}

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: Role;
}

/** Roles that can be granted; ownership only moves by transfer. */
export const grantableRoleSchema = z.enum(['admin', 'editor', 'commenter', 'viewer']);
export type GrantableRole = z.infer<typeof grantableRoleSchema>;

/** Reactions are a fixed set: no arbitrary Unicode (homoglyph or zalgo spam) on comments. */
export const REACTIONS = [
  '👍',
  '👎',
  '❤️',
  '🎉',
  '😄',
  '😮',
  '😢',
  '👀',
  '✅',
  '🙏',
  '🔥',
  '💯',
] as const;
export const reactionSchema = z.enum(REACTIONS);

export interface AttachmentInfo {
  id: string;
  filename: string;
  /** Detected from the file's bytes on upload. */
  contentType: string;
  size: number;
}

export const MAX_ATTACHMENTS_PER_COMMENT = 10;

export interface Comment {
  id: string;
  projectId: string;
  /** Null for a comment on the project itself. */
  taskId: string | null;
  /** Null if the author's account was deleted. */
  userId: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** emoji → who reacted. */
  reactions: Partial<Record<(typeof REACTIONS)[number], string[]>>;
  attachments: AttachmentInfo[];
}

export const ENTITY_TYPES = [
  'projects',
  'sections',
  'tasks',
  'labels',
  'filters',
  'comments',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

const projectFields = {
  name: line(120),
  color: colorSchema,
  viewStyle: viewStyleSchema,
  isFavorite: z.boolean(),
};

const taskFields = {
  content: line(1000),
  description: text(16_000),
  priority: prioritySchema,
  due: dueSchema.nullable(),
  deadline: dateString.nullable(),
  durationMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .nullable(),
  labels: z.array(labelNameSchema).max(50),
  assigneeId: idSchema.nullable(),
};

const labelFields = {
  name: labelNameSchema,
  color: colorSchema,
  itemOrder: orderKeySchema,
  isFavorite: z.boolean(),
};
/** Saved filters must parse (names needn't exist yet: they may be created or shared later). */
export const filterQuerySchema = line(1024).superRefine((v, ctx) => {
  const parsed = parseFilter(v, { now: localNow('UTC') });
  if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.error.message });
});

const filterFields = {
  name: line(120),
  query: filterQuerySchema,
  color: colorSchema,
  itemOrder: orderKeySchema,
  isFavorite: z.boolean(),
};

const byId = z.object({ id: idSchema }).strict();

/** Every command clients may send. Args are strict: unknown fields are rejected, never ignored. */
export const commandArgs = {
  project_add: z
    .object({
      id: idSchema,
      ...partial(projectFields),
      name: projectFields.name,
      parentId: idSchema.nullable().optional(),
      childOrder: orderKeySchema.optional(),
    })
    .strict(),
  project_update: z.object({ id: idSchema, ...partial(projectFields) }).strict(),
  project_move: z
    .object({ id: idSchema, parentId: idSchema.nullable(), childOrder: orderKeySchema.optional() })
    .strict(),
  project_archive: byId,
  project_unarchive: byId,
  project_delete: byId,

  section_add: z
    .object({
      id: idSchema,
      projectId: idSchema,
      name: line(120),
      sectionOrder: orderKeySchema.optional(),
    })
    .strict(),
  section_update: z.object({ id: idSchema, name: line(120) }).strict(),
  section_move: z
    .object({
      id: idSchema,
      projectId: idSchema.optional(),
      sectionOrder: orderKeySchema.optional(),
    })
    .strict(),
  section_archive: byId,
  section_unarchive: byId,
  section_delete: byId,

  task_add: z
    .object({
      id: idSchema,
      projectId: idSchema.optional(),
      sectionId: idSchema.nullable().optional(),
      parentId: idSchema.nullable().optional(),
      childOrder: orderKeySchema.optional(),
      ...partial(taskFields),
      content: taskFields.content,
    })
    .strict(),
  task_update: z.object({ id: idSchema, ...partial(taskFields) }).strict(),
  task_move: z
    .object({
      id: idSchema,
      projectId: idSchema.optional(),
      sectionId: idSchema.nullable().optional(),
      parentId: idSchema.nullable().optional(),
      childOrder: orderKeySchema.optional(),
    })
    .strict(),
  task_complete: byId,
  task_uncomplete: byId,
  task_delete: byId,

  label_add: z.object({ id: idSchema, ...partial(labelFields), name: labelFields.name }).strict(),
  label_update: z.object({ id: idSchema, ...partial(labelFields) }).strict(),
  label_delete: byId,

  filter_add: z
    .object({
      id: idSchema,
      ...partial(filterFields),
      name: filterFields.name,
      query: filterFields.query,
    })
    .strict(),
  filter_update: z.object({ id: idSchema, ...partial(filterFields) }).strict(),
  filter_delete: byId,

  comment_add: z
    .object({
      id: idSchema,
      /** A task comment; or `projectId` alone for a project comment. */
      taskId: idSchema.optional(),
      projectId: idSchema.optional(),
      content: text(15_000),
      /** Files uploaded beforehand (by the same user, to the same project). */
      attachmentIds: z.array(idSchema).max(MAX_ATTACHMENTS_PER_COMMENT).optional(),
    })
    .strict()
    .refine((v) => Boolean(v.taskId) !== Boolean(v.projectId), 'Give taskId or projectId')
    .refine(
      (v) => v.content.trim().length > 0 || (v.attachmentIds?.length ?? 0) > 0,
      'Comment is empty',
    ),
  comment_update: z
    .object({
      id: idSchema,
      content: text(15_000).refine((v) => v.trim().length > 0, 'Comment is empty'),
    })
    .strict(),
  comment_delete: byId,
  reaction_toggle: z.object({ commentId: idSchema, emoji: reactionSchema }).strict(),

  /** Change a member's role (admins and owners; only owners touch admins). */
  project_member_update: z
    .object({ projectId: idSchema, userId: idSchema, role: grantableRoleSchema })
    .strict(),
  /** Remove a member; removing yourself leaves the project (owners must transfer first). */
  project_member_remove: z.object({ projectId: idSchema, userId: idSchema }).strict(),
  /** Hand ownership to another member; the previous owner becomes an admin. */
  project_transfer: z.object({ projectId: idSchema, userId: idSchema }).strict(),

  user_update_preferences: preferencesPatchSchema,
} as const;

export type CommandType = keyof typeof commandArgs;
export type CommandArgs<T extends CommandType> = z.infer<(typeof commandArgs)[T]>;
export const COMMAND_TYPES = Object.keys(commandArgs) as CommandType[];

export type Command = {
  [T in CommandType]: { type: T; uuid: string; args: CommandArgs<T> };
}[CommandType];

/** Envelope check only; args are validated per type so errors name the failing command. */
export const commandEnvelopeSchema = z
  .object({
    type: z.enum(COMMAND_TYPES as [CommandType, ...CommandType[]]),
    uuid: idSchema,
    args: z.unknown(),
  })
  .strict();

export const MAX_COMMANDS_PER_SYNC = 100;

export const syncRequestSchema = z
  .object({
    cursor: z
      .string()
      .regex(/^\d{1,19}$/)
      .nullable()
      .optional(),
    commands: z.array(commandEnvelopeSchema).max(MAX_COMMANDS_PER_SYNC).optional(),
  })
  .strict();
export type SyncRequest = z.input<typeof syncRequestSchema>;

export type CommandError = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'limit_exceeded';
export type CommandResult = { ok: true } | { ok: false; error: CommandError; message?: string };

export interface SyncResponse {
  cursor: string;
  /** True when the client must replace its local state instead of merging. */
  fullSync: boolean;
  user: SyncUser;
  projects: Project[];
  sections: Section[];
  tasks: Task[];
  labels: Label[];
  filters: Filter[];
  comments: Comment[];
  /** IDs the client must drop (deleted, or no longer visible to this user). */
  removed: Record<EntityType, string[]>;
  /** Always complete (not a delta): everyone you share a project with, and every membership. */
  collaborators: Collaborator[];
  members: ProjectMember[];
  /** Direct project invitations waiting for this user. */
  invitations: PendingInvite[];
  results: Record<string, CommandResult>;
}

function partial<T extends Record<string, z.ZodType>>(
  shape: T,
): { [K in keyof T]: z.ZodOptional<T[K]> } {
  return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof T]: z.ZodOptional<T[K]>;
  };
}

// ---------------------------------------------------------------------------------------------
// Project invitations (REST: they carry one-time tokens, so they stay out of sync)
// ---------------------------------------------------------------------------------------------

export const createInviteSchema = z
  .object({
    /** A username or email for a direct invite; omit for a one-time link. */
    identifier: z.string().trim().min(1).max(254).regex(SINGLE_LINE).optional(),
    role: grantableRoleSchema,
  })
  .strict();
export type CreateInvite = z.infer<typeof createInviteSchema>;

/** A pending invite, as project admins see it (never with its token). */
export interface ProjectInvite {
  id: string;
  projectId: string;
  role: GrantableRole;
  kind: 'user' | 'link';
  /** For direct invites: who was invited. */
  invitee: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
}

/** An invite waiting for the current user to accept or decline. */
export interface PendingInvite {
  id: string;
  projectId: string;
  projectName: string;
  role: GrantableRole;
  invitedBy: string | null;
  expiresAt: string;
}

/** One line of a project's or task's activity log. */
export interface ActivityEntry {
  id: number;
  projectId: string;
  taskId: string | null;
  actorId: string | null;
  type: string;
  /** Snapshot at the time (e.g. `title`, `fields`, `userId`). */
  data: Record<string, unknown>;
  at: string;
}
