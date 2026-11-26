import type { ToolDefinition } from './tools.js';
import { ToolError } from './tools.js';
import {
  createHabit,
  deleteHabit,
  getHabit,
  listHabits,
  setHabitCheckIn,
  updateHabit,
} from '../habits/service.js';
import { habitCreateRequestSchema, habitPatchSchema } from '@bokydo/shared';
import { z } from 'zod';

const uuid = z.uuid();
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const add = { ...write, idempotentHint: false } as const;
const deleteHint = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const fail = (error: string): never => {
  throw new ToolError(error);
};

export const HABIT_TOOLS: ToolDefinition[] = [
  {
    name: 'list_habits',
    title: 'List habits',
    description:
      'List your personal habits with current progress, streaks and the last 14 days of check-in history.',
    scopes: ['habits:read'],
    accountWide: true,
    inputSchema: schema({}),
    annotations: read,
    args: z.object({}).strict(),
    run: async (ctx) => listHabits(ctx.db, ctx.userId, ctx.defaultTimeZone),
  },
  {
    name: 'get_habit',
    title: 'Get a habit',
    description:
      'Get one of your personal habits with progress, streak and recent check-in history.',
    scopes: ['habits:read'],
    accountWide: true,
    inputSchema: schema({ id: { type: 'string', format: 'uuid' } }, ['id']),
    annotations: read,
    args: z.object({ id: uuid }).strict(),
    run: async (ctx, a: { id: string }) => ({
      habit:
        (await getHabit(ctx.db, ctx.userId, a.id, ctx.defaultTimeZone)) ?? fail('Habit not found'),
    }),
  },
  {
    name: 'add_habit',
    title: 'Add a habit',
    description:
      'Create a personal habit. Daily targets must be 1; weekly targets may be 1–7. You may supply a stable UUID so retries are safe.',
    scopes: ['habits:write'],
    accountWide: true,
    inputSchema: schema(
      {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        period: { type: 'string', enum: ['day', 'week'] },
        target: { type: 'integer', minimum: 1, maximum: 7 },
      },
      ['name', 'period', 'target'],
    ),
    annotations: add,
    args: habitCreateRequestSchema,
    run: async (ctx, a: z.output<typeof habitCreateRequestSchema>) => {
      const result = await createHabit(ctx.db, ctx.userId, a, ctx.defaultTimeZone);
      if (!result.ok) throw new ToolError(`Habit not created: ${result.error}`);
      if (result.value.created) await ctx.publishHabitChange?.(ctx.userId);
      return { habit: result.value.habit, created: result.value.created };
    },
  },
  {
    name: 'update_habit',
    title: 'Update a habit',
    description:
      'Change a personal habit name, period or target. The combined values are validated together.',
    scopes: ['habits:write'],
    accountWide: true,
    inputSchema: schema(
      {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        period: { type: 'string', enum: ['day', 'week'] },
        target: { type: 'integer', minimum: 1, maximum: 7 },
      },
      ['id'],
    ),
    annotations: write,
    args: z
      .object({ id: uuid, ...habitPatchSchema.shape })
      .strict()
      .refine(
        ({ id: _id, ...patch }) => Object.keys(patch).length > 0,
        'At least one field is required',
      ),
    run: async (
      ctx,
      a: { id: string; name?: string; period?: 'day' | 'week'; target?: number },
    ) => {
      const { id, ...patch } = a;
      const result = await updateHabit(ctx.db, ctx.userId, id, patch, ctx.defaultTimeZone);
      if (!result.ok)
        throw new ToolError(
          result.error === 'not_found' ? 'Habit not found' : `Habit not updated: ${result.error}`,
        );
      await ctx.publishHabitChange?.(ctx.userId);
      return { habit: result.value };
    },
  },
  {
    name: 'delete_habit',
    title: 'Delete a habit',
    description: 'Delete one of your personal habits and its check-in history.',
    scopes: ['habits:write'],
    accountWide: true,
    inputSchema: schema({ id: { type: 'string', format: 'uuid' } }, ['id']),
    annotations: deleteHint,
    args: z.object({ id: uuid }).strict(),
    run: async (ctx, a: { id: string }) => {
      if (!(await deleteHabit(ctx.db, ctx.userId, a.id))) fail('Habit not found');
      await ctx.publishHabitChange?.(ctx.userId);
      return { deleted: true, id: a.id };
    },
  },
  {
    name: 'set_habit_check_in',
    title: 'Set a habit check-in',
    description:
      'Mark a personal habit complete or incomplete on a local calendar date. Future dates are not allowed; repeating the same request is safe.',
    scopes: ['habits:write'],
    accountWide: true,
    inputSchema: schema(
      {
        id: { type: 'string', format: 'uuid' },
        date: { type: 'string', format: 'date' },
        completed: { type: 'boolean' },
      },
      ['id', 'date', 'completed'],
    ),
    annotations: write,
    args: z.object({ id: uuid, date: z.string(), completed: z.boolean() }).strict(),
    run: async (ctx, a: { id: string; date: string; completed: boolean }) => {
      const result = await setHabitCheckIn(
        ctx.db,
        ctx.userId,
        a.id,
        a.date,
        { completed: a.completed },
        ctx.defaultTimeZone,
      );
      if (!result.ok)
        throw new ToolError(
          result.error === 'not_found' ? 'Habit not found' : `Check-in not set: ${result.error}`,
        );
      await ctx.publishHabitChange?.(ctx.userId);
      return { habit: result.value };
    },
  },
];
