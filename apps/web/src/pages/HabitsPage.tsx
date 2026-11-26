import type { HabitSummary, HabitsResponse } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Page, ViewHeader } from '../components/ViewHeader.js';
import { Alert, Button, Card, Dialog, SelectField, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { useConfirm } from '../lib/confirm.js';
import { errorMessage } from '../lib/messages.js';

type HabitInput = { id?: string; name: string; period: 'day' | 'week'; target: number };
const queryKey = ['habits'];
const pathFor = (id: string) => `/api/v1/habits/${encodeURIComponent(id)}`;

export function HabitsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<HabitSummary | null | false>(false);
  const list = useQuery({
    queryKey,
    refetchInterval: 60_000,
    queryFn: () => api<HabitsResponse>('GET', '/api/v1/habits'),
  });
  const refresh = () => client.invalidateQueries({ queryKey });
  const save = useMutation({
    mutationFn: ({ habitId, body }: { habitId?: string; body: HabitInput }) =>
      api<{ habit: HabitSummary }>(
        habitId ? 'PATCH' : 'POST',
        habitId ? pathFor(habitId) : '/api/v1/habits',
        body,
      ),
    onSuccess: async () => {
      await refresh();
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<null>('DELETE', pathFor(id)),
    onSuccess: refresh,
  });
  const checkIn = useMutation({
    mutationFn: ({ id, date, completed }: { id: string; date: string; completed: boolean }) =>
      api<{ habit: HabitSummary }>('PUT', `${pathFor(id)}/check-ins/${date}`, { completed }),
    onSuccess: refresh,
  });
  const onDelete = async (habit: HabitSummary) => {
    if (
      await confirm({
        title: t('habits.deleteTitle', { defaultValue: 'Delete habit?' }),
        message: t('habits.deleteMessage', {
          name: habit.name,
          defaultValue: 'Delete “{{name}}” and its check-in history?',
        }),
        confirmLabel: t('habits.delete', { defaultValue: 'Delete' }),
        danger: true,
      })
    )
      remove.mutate(habit.id);
  };
  return (
    <Page>
      <ViewHeader
        title={t('habits.title', { defaultValue: 'Habits' })}
        subtitle={t('habits.subtitle', {
          defaultValue: 'Build routines with small, repeatable check-ins.',
        })}
        actions={
          <Button
            disabled={save.isPending}
            onClick={() => {
              save.reset();
              setEditing(null);
            }}
          >
            {t('habits.add', { defaultValue: 'Add habit' })}
          </Button>
        }
      />
      <div className="mx-auto max-w-3xl space-y-4">
        {list.isError && (
          <Alert>
            {errorMessage(list.error)}{' '}
            <Button variant="secondary" onClick={() => void list.refetch()}>
              {t('common.retry', { defaultValue: 'Try again' })}
            </Button>
          </Alert>
        )}
        {(remove.isError || checkIn.isError) && (
          <Alert>
            {errorMessage(remove.error ?? checkIn.error)}{' '}
            <Button
              variant="secondary"
              onClick={() => {
                if (remove.isError && remove.variables) remove.mutate(remove.variables);
                else if (checkIn.isError && checkIn.variables) checkIn.mutate(checkIn.variables);
              }}
            >
              {t('common.retry', { defaultValue: 'Try again' })}
            </Button>
          </Alert>
        )}
        {list.isPending && (
          <p className="text-sm text-muted" role="status">
            {t('common.loading', { defaultValue: 'Loading…' })}
          </p>
        )}
        {list.data?.habits.length === 0 && (
          <Card>
            <h2 className="font-semibold">
              {t('habits.emptyTitle', { defaultValue: 'Start with one habit' })}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {t('habits.emptyBody', {
                defaultValue: 'Choose something small you want to do regularly.',
              })}
            </p>
            <Button
              className="mt-4"
              disabled={save.isPending}
              onClick={() => {
                save.reset();
                setEditing(null);
              }}
            >
              {t('habits.addFirst', { defaultValue: 'Create your first habit' })}
            </Button>
          </Card>
        )}
        {list.data?.habits.map((habit) => (
          <HabitCard
            key={habit.id}
            habit={habit}
            today={list.data.today}
            busy={checkIn.isPending || remove.isPending || save.isPending}
            onCheck={(date, completed) => checkIn.mutate({ id: habit.id, date, completed })}
            onEdit={() => {
              save.reset();
              setEditing(habit);
            }}
            onDelete={() => void onDelete(habit)}
          />
        ))}
      </div>
      <HabitDialog
        key={editing === false ? 'closed' : (editing?.id ?? 'new')}
        open={editing !== false}
        habit={editing || null}
        busy={save.isPending}
        error={save.isError ? errorMessage(save.error) : null}
        onClose={() => setEditing(false)}
        onSubmit={(value) =>
          save.mutate({ body: value, ...(editing ? { habitId: editing.id } : {}) })
        }
      />
    </Page>
  );
}

function HabitCard({
  habit,
  today,
  busy,
  onCheck,
  onEdit,
  onDelete,
}: {
  habit: HabitSummary;
  today: string;
  busy: boolean;
  onCheck: (date: string, value: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const history = habit.history.filter((item) => item.date <= today).slice(-14);
  return (
    <section aria-label={habit.name}>
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="break-words font-semibold">{habit.name}</h2>
            <p className="mt-1 text-sm text-muted">
              {habit.period === 'day'
                ? t('habits.dailyTarget', { defaultValue: 'Every day' })
                : t('habits.weeklyTarget', {
                    count: habit.target,
                    defaultValue: '{{count}} days a week',
                  })}{' '}
              · {habit.progress.completed}/{habit.progress.target}{' '}
              {t('habits.thisPeriod', { defaultValue: 'this period' })}
            </p>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" className="px-2" disabled={busy} onClick={onEdit}>
              {t('common.edit', { defaultValue: 'Edit' })}
            </Button>
            <Button variant="ghost" className="px-2 text-danger" disabled={busy} onClick={onDelete}>
              {t('common.delete', { defaultValue: 'Delete' })}
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <Button
            variant={habit.todayCompleted ? 'secondary' : 'primary'}
            disabled={busy}
            aria-label={t('habits.todayToggle', {
              name: habit.name,
              defaultValue: 'Today: {{name}}',
            })}
            aria-pressed={habit.todayCompleted}
            onClick={() => onCheck(today, !habit.todayCompleted)}
          >
            {habit.todayCompleted
              ? t('habits.doneToday', { defaultValue: 'Done today' })
              : t('habits.markDone', { defaultValue: 'Mark done today' })}
          </Button>
          <p className="text-sm text-muted">
            {habit.streak.unit === 'day'
              ? t('habits.dayStreak', {
                  count: habit.streak.current,
                  defaultValue: '{{count}} day streak',
                })
              : t('habits.weekStreak', {
                  count: habit.streak.current,
                  defaultValue: '{{count}} week streak',
                })}
          </p>
        </div>
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-2 text-xs font-medium text-muted">
            {t('habits.last14', {
              defaultValue: 'Last 14 days · select a day to change its check-in',
            })}
          </p>
          <div
            className="grid grid-cols-7 gap-1.5 "
            role="group"
            aria-label={t('habits.historyLabel', {
              name: habit.name,
              defaultValue: '{{name}} check-in history',
            })}
          >
            {history.map(({ date, completed }) => (
              <button
                key={date}
                type="button"
                aria-label={t('habits.historyToggle', {
                  name: habit.name,
                  date,
                  completed: completed
                    ? t('habits.completed', { defaultValue: 'completed' })
                    : t('habits.notCompleted', { defaultValue: 'not completed' }),
                  defaultValue: '{{date}}, {{name}}, {{completed}}',
                })}
                title={date}
                aria-pressed={completed}
                disabled={busy}
                onClick={() => onCheck(date, !completed)}
                className={`flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg border text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 ${completed ? 'border-accent bg-accent/15 text-fg' : 'border-line bg-bg text-muted hover:bg-surface-alt'}`}
              >
                <span aria-hidden="true">{completed ? '✓' : '·'}</span>
                <span aria-hidden="true">
                  {new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
                    weekday: 'narrow',
                    timeZone: 'UTC',
                  })}
                </span>
                <span aria-hidden>{Number(date.slice(-2))}</span>
              </button>
            ))}
          </div>
        </div>
      </Card>
    </section>
  );
}

function HabitDialog({
  open,
  habit,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  habit: HabitSummary | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: HabitInput) => void;
}) {
  const { t } = useTranslation();
  const [createId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(habit?.name ?? '');
  const [period, setPeriod] = useState<'day' | 'week'>(habit?.period ?? 'day');
  const [target, setTarget] = useState(String(habit?.target ?? 1));
  const parsed = Number(target);
  const validTarget =
    Number.isInteger(parsed) && (period === 'day' ? parsed === 1 : parsed >= 1 && parsed <= 7);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && validTarget)
      onSubmit({ name: name.trim(), period, target: parsed, ...(habit ? {} : { id: createId }) });
  };
  return (
    <Dialog
      open={open}
      dismissible={!busy}
      onClose={onClose}
      title={
        habit
          ? t('habits.editTitle', { defaultValue: 'Edit habit' })
          : t('habits.newTitle', { defaultValue: 'New habit' })
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <TextField
          autoFocus
          label={t('habits.name', { defaultValue: 'Habit name' })}
          value={name}
          maxLength={100}
          required
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <SelectField
          label={t('habits.frequency', { defaultValue: 'Frequency' })}
          value={period}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as 'day' | 'week';
            setPeriod(next);
            if (next === 'day') setTarget('1');
          }}
          options={[
            { value: 'day', label: t('habits.everyDay', { defaultValue: 'Daily' }) },
            { value: 'week', label: t('habits.perWeek', { defaultValue: 'Weekly' }) },
          ]}
        />
        {period === 'week' && (
          <TextField
            label={t('habits.target', { defaultValue: 'Target each week' })}
            type="number"
            min={1}
            max={7}
            step={1}
            value={target}
            required
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
          />
        )}
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type="submit" busy={busy} disabled={!name.trim() || !validTarget}>
            {habit
              ? t('common.save', { defaultValue: 'Save changes' })
              : t('habits.create', { defaultValue: 'Create habit' })}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
