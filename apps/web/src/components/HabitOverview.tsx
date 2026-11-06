import type { HabitSummary, HabitsResponse } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Alert, Button } from './ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';

const queryKey = ['habits'];
const pathFor = (id: string) => `/api/v1/habits/${encodeURIComponent(id)}`;

export function HabitOverview({ onHide }: { onHide: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const list = useQuery({
    queryKey,
    refetchInterval: 60_000,
    queryFn: () => api<HabitsResponse>('GET', '/api/v1/habits'),
  });
  const checkIn = useMutation({
    mutationFn: ({ id, date, completed }: { id: string; date: string; completed: boolean }) =>
      api<{ habit: HabitSummary }>('PUT', `${pathFor(id)}/check-ins/${date}`, { completed }),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });

  return (
    <section
      aria-label={t('habits.overviewLabel', { defaultValue: 'Habits overview' })}
      className="mt-8 rounded-2xl border border-dashed border-accent/40 bg-accent/5 p-3 sm:p-4"
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold text-fg">
          <span aria-hidden="true" className="text-accent">
            ↻
          </span>
          {t('habits.title', { defaultValue: 'Habits' })}
        </h2>
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onHide}>
          {t('habits.hideOverview', { defaultValue: 'Hide habits' })}
        </Button>
      </header>

      {list.isError && (
        <Alert>
          {errorMessage(list.error)}{' '}
          <Button variant="secondary" onClick={() => void list.refetch()}>
            {t('common.retry', { defaultValue: 'Try again' })}
          </Button>
        </Alert>
      )}
      {checkIn.isError && (
        <div className="mb-3">
          <Alert>
            {errorMessage(checkIn.error)}{' '}
            <Button
              variant="secondary"
              onClick={() => {
                if (checkIn.variables) checkIn.mutate(checkIn.variables);
              }}
            >
              {t('common.retry', { defaultValue: 'Try again' })}
            </Button>
          </Alert>
        </div>
      )}
      {list.isPending && (
        <p className="text-sm text-muted" role="status">
          {t('common.loading', { defaultValue: 'Loading…' })}
        </p>
      )}
      {list.data?.habits.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted">
            {t('habits.overviewEmpty', {
              defaultValue: 'Add a habit to keep your regular check-ins in view.',
            })}
          </p>
          <Link to="/habits" className="text-sm font-medium text-accent hover:underline">
            {t('habits.manage', { defaultValue: 'Manage habits' })}
          </Link>
        </div>
      )}
      {list.data && list.data.habits.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3">
          {list.data.habits.map((habit) => (
            <HabitItem
              key={habit.id}
              habit={habit}
              busy={checkIn.isPending}
              onCheck={(completed) =>
                checkIn.mutate({ id: habit.id, date: list.data.today, completed })
              }
            />
          ))}
        </ul>
      )}
      {list.data && list.data.habits.length > 0 && (
        <div className="mt-3 flex justify-end">
          <Link to="/habits" className="text-sm font-medium text-accent hover:underline">
            {t('habits.manage', { defaultValue: 'Manage habits' })}
          </Link>
        </div>
      )}
    </section>
  );
}

function HabitItem({
  habit,
  busy,
  onCheck,
}: {
  habit: HabitSummary;
  busy: boolean;
  onCheck: (completed: boolean) => void;
}) {
  const { t } = useTranslation();
  const progress = Math.max(0, Math.min(habit.progress.target, habit.progress.completed));
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
      <button
        type="button"
        aria-label={t('habits.todayToggle', {
          name: habit.name,
          defaultValue: 'Today: {{name}}',
        })}
        aria-pressed={habit.todayCompleted}
        disabled={busy}
        onClick={() => onCheck(!habit.todayCompleted)}
        className={`flex size-9 shrink-0 items-center justify-center rounded-md border text-base font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${habit.todayCompleted ? 'border-accent bg-accent/15 text-fg' : 'border-line bg-bg text-muted hover:bg-surface-alt'}`}
      >
        <span aria-hidden="true">{habit.todayCompleted ? '✓' : ''}</span>
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{habit.name}</p>
        <p className="text-xs leading-relaxed text-muted">
          {habit.period === 'day'
            ? t('habits.dailyTarget', { defaultValue: 'Every day' })
            : t('habits.weeklyTarget', {
                count: habit.target,
                defaultValue: '{{count}} days a week',
              })}
          {' · '}
          {habit.progress.completed}/{habit.progress.target}{' '}
          {t('habits.thisPeriod', { defaultValue: 'this period' })}
          {habit.streak.current > 0 && (
            <>
              {' · '}
              {habit.streak.unit === 'day'
                ? t('habits.dayStreak', {
                    count: habit.streak.current,
                    defaultValue: '{{count}} day streak',
                  })
                : t('habits.weekStreak', {
                    count: habit.streak.current,
                    defaultValue: '{{count}} week streak',
                  })}
            </>
          )}
        </p>
        <div
          className="mt-1 h-1 overflow-hidden rounded-full bg-surface-alt"
          role="progressbar"
          aria-label={t('habits.overviewProgress', {
            name: habit.name,
            defaultValue: '{{name}} progress',
          })}
          aria-valuemin={0}
          aria-valuemax={habit.progress.target}
          aria-valuenow={progress}
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{
              width: `${habit.progress.target ? (progress / habit.progress.target) * 100 : 0}%`,
            }}
          />
        </div>
      </div>
    </li>
  );
}
