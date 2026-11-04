import { z } from 'zod';

export const habitPeriodSchema = z.enum(['day', 'week']);
export type HabitPeriod = z.infer<typeof habitPeriodSchema>;

export const habitFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    period: habitPeriodSchema,
    target: z.number().int().min(1).max(7),
  })
  .strict()
  .refine((h) => h.period !== 'day' || h.target === 1, {
    message: 'A daily habit target must be 1',
    path: ['target'],
  });

export const habitCreateSchema = habitFieldsSchema;
export const habitCreateRequestSchema = habitFieldsSchema
  .safeExtend({ id: z.uuid().optional() })
  .strict();
export const habitPatchSchema = z
  .object({
    name: habitFieldsSchema.shape.name.optional(),
    period: habitFieldsSchema.shape.period.optional(),
    target: habitFieldsSchema.shape.target.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const habitCheckInSchema = z.object({ completed: z.boolean() }).strict();

export interface HabitSummary {
  id: string;
  name: string;
  period: HabitPeriod;
  target: number;
  createdAt: string;
  updatedAt: string;
  todayCompleted: boolean;
  progress: { completed: number; target: number; start: string; end: string };
  streak: { current: number; unit: HabitPeriod };
  history: { date: string; completed: boolean }[];
}

export interface HabitsResponse {
  today: string;
  habits: HabitSummary[];
}
