import { sql } from 'drizzle-orm';
import type { Due } from '@bokydo/shared';
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable(
  'users',
  {
    // UUIDv7, generated in the app (see ids.ts). Never sequential.
    id: uuid('id').primaryKey(),
    username: text('username').notNull(),
    email: text('email'),
    passwordHash: text('password_hash').notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_username_lower_idx').on(sql`lower(${t.username})`),
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
  ],
);

/** Instance-wide settings managed in Admin → Settings. Keys are namespaced, e.g. `setup.complete`. */
export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  /** Plain JSON, or an EncryptedValue envelope for secret settings. */
  value: jsonb('value').notNull(),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Server-side sessions. `id` is HMAC-SHA256(session.key, token): the raw token only ever lives in
 * the user's cookie, so a database leak alone cannot be replayed as sessions.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/** Append-only security audit trail. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type', { enum: ['system', 'cli', 'user'] }).notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    meta: jsonb('meta').notNull().default({}),
  },
  (t) => [index('audit_log_at_idx').on(t.at)],
);

// ---------------------------------------------------------------------------------------------
// Tasks domain (F4). Rows are soft-deleted (`deleted_at`) so sync can hand out tombstones.
// Order keys are fractional strings compared in byte order (see @bokydo/shared/ordering).
// ---------------------------------------------------------------------------------------------

const softDelete = {
  ...timestamps,
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => projects.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    color: text('color').notNull().default('charcoal'),
    viewStyle: text('view_style').notNull().default('list'),
    childOrder: text('child_order').notNull(),
    isInbox: boolean('is_inbox').notNull().default(false),
    isArchived: boolean('is_archived').notNull().default(false),
    ...softDelete,
  },
  (t) => [
    index('projects_owner_idx').on(t.ownerId),
    // One live inbox per user.
    uniqueIndex('projects_one_inbox_idx')
      .on(t.ownerId)
      .where(sql`${t.isInbox} and ${t.deletedAt} is null`),
  ],
);

/** Who can see a project and with which role. The owner has a row too. */
export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'editor', 'commenter', 'viewer'] }).notNull(),
    isFavorite: boolean('is_favorite').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_members_user_idx').on(t.userId),
  ],
);

export const sections = pgTable(
  'sections',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sectionOrder: text('section_order').notNull(),
    isArchived: boolean('is_archived').notNull().default(false),
    ...softDelete,
  },
  (t) => [index('sections_project_idx').on(t.projectId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').references(() => sections.id, { onDelete: 'set null' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => tasks.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    description: text('description').notNull().default(''),
    priority: integer('priority').notNull().default(4),
    /** Local calendar date of the due date (indexed for Today/Upcoming). */
    dueDate: date('due_date'),
    due: jsonb('due').$type<Due>(),
    deadline: date('deadline'),
    durationMinutes: integer('duration_minutes'),
    labels: text('labels')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    assignedById: uuid('assigned_by_id').references(() => users.id, { onDelete: 'set null' }),
    childOrder: text('child_order').notNull(),
    isCompleted: boolean('is_completed').notNull().default(false),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedById: uuid('completed_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...softDelete,
  },
  (t) => [
    index('tasks_project_idx').on(t.projectId, t.isCompleted),
    index('tasks_parent_idx').on(t.parentId),
    index('tasks_section_idx').on(t.sectionId),
    index('tasks_due_idx').on(t.dueDate),
    index('tasks_assignee_idx').on(t.assigneeId),
  ],
);

/** Personal label metadata. Tasks carry label *names*, so labels on shared tasks need no join. */
export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('charcoal'),
    itemOrder: text('item_order').notNull(),
    isFavorite: boolean('is_favorite').notNull().default(false),
    ...softDelete,
  },
  (t) => [
    uniqueIndex('labels_user_name_idx')
      .on(t.userId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const filters = pgTable(
  'filters',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    query: text('query').notNull(),
    color: text('color').notNull().default('charcoal'),
    itemOrder: text('item_order').notNull(),
    isFavorite: boolean('is_favorite').notNull().default(false),
    ...softDelete,
  },
  (t) => [index('filters_user_idx').on(t.userId)],
);

/**
 * Sync change log: "this entity changed, in this scope". It deliberately holds no data; sync
 * re-reads current rows and re-checks visibility, so nothing leaks across scopes. Writers hold a
 * global advisory lock, so committed `seq` values never appear out of order.
 */
export const changes = pgTable(
  'changes',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    entityType: text('entity_type', {
      enum: ['projects', 'sections', 'tasks', 'labels', 'filters', 'project_access'],
    }).notNull(),
    entityId: uuid('entity_id').notNull(),
    /** Project scope: visible to the project's members. */
    projectId: uuid('project_id'),
    /** User scope: visible to this user only. */
    userId: uuid('user_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('changes_project_idx').on(t.projectId, t.seq),
    index('changes_user_idx').on(t.userId, t.seq),
  ],
);

/** Idempotency: a command UUID is applied at most once per user; replays return the stored result. */
export const processedCommands = pgTable(
  'processed_commands',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    uuid: uuid('uuid').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.uuid] })],
);
