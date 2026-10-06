import { sql } from 'drizzle-orm';
import type { Due } from '@bokydo/shared';
import {
  bigint,
  bigserial,
  boolean,
  check,
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
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** TOTP secret, envelope-encrypted (EncryptedValue). */
    totpSecret: jsonb('totp_secret'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    /** Last accepted TOTP time step: a code can never be used twice. */
    totpLastStep: integer('totp_last_step'),
    /** User preferences (validated by @bokydo/shared preferencesSchema; merged over defaults on read). */
    preferences: jsonb('preferences').notNull().default({}),
    /** The user's local date of the last daily digest sent (so it goes out once a day). */
    lastDigestOn: date('last_digest_on'),
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
    /** Identifier shown in the sessions list (the primary key is derived from the secret token). */
    publicId: uuid('public_id').notNull().defaultRandom().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    authMethod: text('auth_method').notNull().default('password'),
    /** Last time the user proved who they are (login or re-auth); gates sensitive actions. */
    reauthenticatedAt: timestamp('reauthenticated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    /** Team workspace this project belongs to (null: personal). */
    workspaceId: uuid('workspace_id').references((): AnyPgColumn => workspaces.id, {
      onDelete: 'cascade',
    }),
    folderId: uuid('folder_id').references((): AnyPgColumn => folders.id, { onDelete: 'set null' }),
    /** Workspace projects: 'workspace' = every workspace member (not guests) gets access. */
    visibility: text('visibility', { enum: ['restricted', 'workspace'] })
      .notNull()
      .default('restricted'),
    ...softDelete,
  },
  (t) => [
    index('projects_owner_idx').on(t.ownerId),
    index('projects_workspace_idx').on(t.workspaceId),
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
    /** 'workspace': granted by workspace membership (and withdrawn with it); 'direct': shared. */
    source: text('source', { enum: ['direct', 'workspace'] })
      .notNull()
      .default('direct'),
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
    index('tasks_completed_idx').on(t.projectId, t.completedAt),
    // Full-text search over title + description ('simple': no language-specific stemming).
    index('tasks_search_idx').using(
      'gin',
      sql`to_tsvector('simple', ${t.content} || ' ' || ${t.description})`,
    ),
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
      enum: [
        'projects',
        'sections',
        'tasks',
        'labels',
        'filters',
        'project_access',
        'user',
        'invitations',
        'comments',
        'notifications',
        'workspaces',
        'reminders',
      ],
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

// ---------------------------------------------------------------------------------------------
// Account security (W1)
// ---------------------------------------------------------------------------------------------

/** Single-use MFA recovery codes, stored as keyed hashes. */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('recovery_codes_hash_idx').on(t.userId, t.codeHash)],
);

/** Passkeys / security keys (WebAuthn credentials). */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    /** Credential ID, base64url. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    aaguid: text('aaguid'),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [index('webauthn_credentials_user_idx').on(t.userId)],
);

/**
 * Short-lived, multi-step authentication state: the MFA step after a password, passkey
 * challenges, pending TOTP enrolment. `id` is HMAC(session.key, token); the token lives in an
 * HttpOnly cookie or is bound to the session.
 */
export const authFlows = pgTable(
  'auth_flows',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: ['mfa', 'passkey_login', 'passkey_register', 'totp_setup', 'reauth_passkey'],
    }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    challenge: text('challenge'),
    /** Encrypted payload (e.g. a TOTP secret awaiting confirmation). */
    secret: jsonb('secret'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('auth_flows_session_idx').on(t.sessionId, t.kind)],
);

/** Single-use emailed/linked tokens: password reset, email verification, invitations. */
export const userTokens = pgTable(
  'user_tokens',
  {
    /** HMAC(session.key, token). */
    id: text('id').primaryKey(),
    /** Stable public reference (e.g. to revoke an invite). */
    ref: uuid('ref').notNull().defaultRandom().unique(),
    kind: text('kind', { enum: ['password_reset', 'email_verify', 'invite'] }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    data: jsonb('data').notNull().default({}),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('user_tokens_user_idx').on(t.userId, t.kind)],
);

/**
 * Invitations to a project. Direct invites name an existing user, who accepts from their inbox;
 * link invites carry a one-time token (stored only as an HMAC). The role is fixed here when the
 * invite is created, so nothing the invitee sends can change it.
 */
export const projectInvitations = pgTable(
  'project_invitations',
  {
    id: uuid('id').primaryKey(),
    /** Exactly one of projectId / workspaceId is set. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references((): AnyPgColumn => workspaces.id, {
      onDelete: 'cascade',
    }),
    /** A project role, or a workspace role (admin / member / guest). */
    role: text('role', {
      enum: ['admin', 'editor', 'commenter', 'viewer', 'member', 'guest'],
    }).notNull(),
    inviteeId: uuid('invitee_id').references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').unique(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedById: uuid('accepted_by_id').references(() => users.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'project_invitations_one_target',
      sql`(${t.projectId} is null) <> (${t.workspaceId} is null)`,
    ),
    index('project_invitations_project_idx').on(t.projectId),
    index('project_invitations_invitee_idx').on(t.inviteeId),
  ],
);

/** Comments on a task (or, with no task, on the project itself). Markdown, rendered safely. */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    content: text('content').notNull(),
    ...softDelete,
  },
  (t) => [index('comments_project_idx').on(t.projectId), index('comments_task_idx').on(t.taskId)],
);

export const commentReactions = pgTable(
  'comment_reactions',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.userId, t.emoji] })],
);

/**
 * What happened in a project, for the activity log: who did what to which task. Readable by the
 * project's members; `data` holds a snapshot (e.g. the task title) so entries outlive deletions.
 */
export const activity = pgTable(
  'activity',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    data: jsonb('data').notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('activity_project_idx').on(t.projectId, t.id),
    index('activity_task_idx').on(t.taskId, t.id),
  ],
);

/**
 * Files attached to comments. Stored on the data volume under their ID (never under the
 * uploaded name); `contentType` comes from the file's own bytes, not from the uploader.
 * An upload is pending (no comment) until a comment claims it; unclaimed ones are purged.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'set null' }),
    uploaderId: uuid('uploader_id').references(() => users.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('attachments_project_idx').on(t.projectId),
    index('attachments_comment_idx').on(t.commentId),
  ],
);

/** In-app notifications (W6 adds email and push delivery of the same events). */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id'),
    commentId: uuid('comment_id'),
    data: jsonb('data').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** Set once email/push delivery was decided (the outbox for the delivery job). */
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt),
    index('notifications_actor_idx').on(t.actorId, t.createdAt),
    index('notifications_outbox_idx')
      .on(t.createdAt)
      .where(sql`dispatched_at is null`),
  ],
);

/**
 * Personal reminders. `fireAt` is derived (recomputed whenever the task's due date, the owner's
 * time zone or the reminder changes); `firedFor` is the `fireAt` value already delivered, so a
 * recurring task's next occurrence fires again while a delivered one never repeats.
 */
export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    minutesBefore: integer('minutes_before'),
    date: date('date'),
    time: text('time'),
    timeZone: text('time_zone'),
    isAuto: boolean('is_auto').notNull().default(false),
    fireAt: timestamp('fire_at', { withTimezone: true }),
    firedFor: timestamp('fired_for', { withTimezone: true }),
    ...softDelete,
  },
  (t) => [
    index('reminders_task_idx').on(t.taskId),
    index('reminders_user_idx').on(t.userId),
    index('reminders_due_idx')
      .on(t.fireAt)
      .where(sql`deleted_at is null`),
    check('reminders_type_check', sql`type in ('relative', 'absolute')`),
  ],
);

/**
 * Web Push subscriptions, one per browser, tied to the session that registered it: signing out
 * (or the session expiring) removes it, so a shared browser never gets someone else's alerts.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    failures: integer('failures').notNull().default(0),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
);

/** Team workspaces: a group of people and the projects they share. */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  ...softDelete,
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'member', 'guest'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('workspace_members_user_idx').on(t.userId),
  ],
);

/** Folders group a workspace's projects in the sidebar. */
export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    childOrder: text('child_order').notNull(),
    ...softDelete,
  },
  (t) => [index('folders_workspace_idx').on(t.workspaceId)],
);
