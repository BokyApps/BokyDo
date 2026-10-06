import type { Preferences, Reminder } from '@bokydo/shared';
import { describeDate } from './dates.js';

/** Offsets offered for reminders relative to a task's due time (minutes before). */
export const RELATIVE_PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440] as const;

export function relativeLabel(minutes: number): string {
  if (minutes === 0) return 'At the time of the task';
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'} before`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'} before`;
  return `${minutes} min before`;
}

export function reminderLabel(
  r: Pick<Reminder, 'type' | 'minutesBefore' | 'date' | 'time'>,
  today: string,
  prefs: Pick<Preferences, 'timeFormat' | 'dateFormat'>,
): string {
  if (r.type === 'relative') return relativeLabel(r.minutesBefore ?? 0);
  return r.date ? describeDate(r.date, r.time, today, prefs).label : 'Reminder';
}

/** The user's reminders on a task, relative ones first, then by time. */
export function remindersOf(reminders: ReadonlyMap<string, Reminder>, taskId: string): Reminder[] {
  return [...reminders.values()]
    .filter((r) => r.taskId === taskId)
    .sort((a, b) =>
      a.type !== b.type
        ? a.type === 'relative'
          ? -1
          : 1
        : a.type === 'relative'
          ? (b.minutesBefore ?? 0) - (a.minutesBefore ?? 0)
          : `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`),
    );
}
