import type { Task } from '@bokydo/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { todayIn } from '../lib/dates.js';
import { RELATIVE_PRESETS, relativeLabel, reminderLabel, remindersOf } from '../lib/reminders.js';
import { newId, usePreferences, useSend, useSyncState, useTimeZone } from '../lib/sync.js';
import { Button, inputClass, Popover } from './ui.js';

/** Your reminders on a task: list, delete, add (relative to its time, or at a date and time). */
export function TaskReminders({ task }: { task: Task }) {
  const { t } = useTranslation();
  const state = useSyncState();
  const prefs = usePreferences();
  const send = useSend();
  const today = todayIn(useTimeZone());
  const list = remindersOf(state.reminders, task.id);
  const timed = Boolean(task.due?.time);

  return (
    <div className="space-y-1">
      {list.length === 0 && <p className="text-muted">{t('reminders.none')}</p>}
      <ul className="space-y-0.5">
        {list.map((r) => (
          <li key={r.id} className="group flex items-center gap-1">
            <span aria-hidden>⏰</span>
            <span
              className={`flex-1 truncate ${r.type === 'relative' && !timed ? 'text-muted line-through' : ''}`}
            >
              {reminderLabel(r, today, prefs)}
              {r.isAuto && <span className="text-xs text-muted"> {t('reminders.automatic')}</span>}
            </span>
            <button
              type="button"
              aria-label={t('reminders.delete', { label: reminderLabel(r, today, prefs) })}
              className="rounded px-1 text-muted opacity-60 hover:bg-surface hover:text-danger group-hover:opacity-100"
              onClick={() => send('reminder_delete', { id: r.id })}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {list.some((r) => r.type === 'relative') && !timed && (
        <p className="text-xs text-muted">{t('reminders.relativeNote')}</p>
      )}
      <AddReminder task={task} timed={timed} today={today} />
    </div>
  );
}

function AddReminder({ task, timed, today }: { task: Task; timed: boolean; today: string }) {
  const { t } = useTranslation();
  const send = useSend();
  const [date, setDate] = useState(task.due?.date ?? today);
  const [time, setTime] = useState(task.due?.time ?? '09:00');
  return (
    <Popover
      trigger={(p) => (
        <Button variant="ghost" className="!px-1" {...p}>
          {t('reminders.add')}
        </Button>
      )}
    >
      {(close) => (
        <div className="w-60 space-y-3 p-2 text-sm">
          {timed ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted">{t('reminders.beforeTask')}</p>
              <div className="flex flex-wrap gap-1">
                {RELATIVE_PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-alt"
                    onClick={() => {
                      send('reminder_add', {
                        id: newId(),
                        taskId: task.id,
                        type: 'relative',
                        minutesBefore: m,
                      });
                      close();
                    }}
                  >
                    {m === 0 ? t('reminders.atTime') : relativeLabel(m).replace(' before', '')}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted">{t('reminders.giveTime')}</p>
          )}
          <form
            className="space-y-1"
            onSubmit={(e) => {
              e.preventDefault();
              send('reminder_add', { id: newId(), taskId: task.id, type: 'absolute', date, time });
              close();
            }}
          >
            <p className="text-xs font-medium text-muted">{t('reminders.atDateAndTime')}</p>
            <div className="flex gap-1">
              <input
                type="date"
                aria-label={t('reminders.dateAria')}
                required
                className={`${inputClass} py-1`}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <input
                type="time"
                aria-label={t('reminders.timeAria')}
                required
                className={`${inputClass} w-24 py-1`}
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full">
              {t('common.add')}
            </Button>
          </form>
        </div>
      )}
    </Popover>
  );
}
