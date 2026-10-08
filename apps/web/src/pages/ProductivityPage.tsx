import type { ProductivitySummary } from '@bokydo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Page, ViewHeader } from '../components/ViewHeader.js';
import { Alert, Button, Card, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { usePreferences, useSend, useSyncState } from '../lib/sync.js';

const n = (value: number) => value.toLocaleString();
const weekday = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'narrow' });

/** Karma, goals, the streak and the last two weeks. */
export function ProductivityPage() {
  const state = useSyncState();
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryKey: ['productivity'],
    queryFn: () => api<ProductivitySummary>('GET', '/api/v1/productivity'),
  });

  // Completions change the numbers, so refetch whenever the synced tasks change.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['productivity'] });
  }, [state.tasks, queryClient]);

  const data = summary.data;
  return (
    <Page>
      <ViewHeader title="Productivity" />
      <div className="mx-auto max-w-2xl space-y-6">
        {summary.isError && <Alert>{errorMessage(summary.error)}</Alert>}
        {!data && !summary.isError && <p className="text-sm text-muted">Loading…</p>}
        {data && (
          <>
            <KarmaCard summary={data} />
            <GoalsCard summary={data} />
            <VacationCard summary={data} />
            <DaysCard summary={data} />
          </>
        )}
      </div>
    </Page>
  );
}

function KarmaCard({ summary }: { summary: ProductivitySummary }) {
  const { level, karma } = summary;
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Karma</h2>
      <p className="mb-4 text-sm text-muted">
        Points for finishing things, more for what mattered most: a top-priority task is worth five,
        the lowest one.
      </p>
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-semibold tabular-nums">{n(karma)}</span>
        <span className="text-sm font-medium">{level.name}</span>
      </div>
      {level.next !== null && (
        <>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-valuenow={Math.round(level.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Progress to the next level`}
          >
            <div className="h-full bg-accent" style={{ width: `${level.progress * 100}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted">
            {n(level.next - karma)} more to reach the next level.
          </p>
        </>
      )}
      <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <Stat label="Today" value={`${summary.today.completed} of ${summary.today.goal}`} />
        <Stat label="This week" value={`${summary.week.completed} of ${summary.week.goal}`} />
        <Stat
          label="Streak"
          value={summary.streak.current === 1 ? '1 day' : `${summary.streak.current} days`}
        />
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="font-medium tabular-nums">{value}</p>
    </div>
  );
}

function DaysCard({ summary }: { summary: ProductivitySummary }) {
  const most = Math.max(1, ...summary.days.map((d) => d.completed));
  return (
    <Card>
      <h2 className="mb-4 font-semibold">The last two weeks</h2>
      <ul className="flex items-end justify-between gap-1" aria-hidden="true">
        {summary.days.map((day) => (
          <li key={day.date} className="flex flex-1 flex-col items-center gap-1">
            <div
              className={`w-full rounded-sm ${day.met ? 'bg-accent' : day.completed > 0 ? 'bg-accent/40' : 'bg-line'} ${day.vacation ? 'opacity-40' : ''}`}
              style={{ height: `${Math.max(4, (day.completed / most) * 64)}px` }}
            />
            <span className="text-[10px] text-muted">{weekday(day.date)}</span>
          </li>
        ))}
      </ul>
      <ul className="sr-only">
        {summary.days.map((day) => (
          <li key={day.date}>
            {day.date}: {day.completed} completed, goal {day.goal}
            {day.vacation ? ' (vacation)' : day.met ? ' (met)' : ''}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function GoalsCard({ summary }: { summary: ProductivitySummary }) {
  const prefs = usePreferences();
  const send = useSend();
  const [daily, setDaily] = useState<string | null>(null);
  const [weekly, setWeekly] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dailyValue = daily ?? String(prefs.productivity.dailyGoal);
  const weeklyValue = weekly ?? String(prefs.productivity.weeklyGoal);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send('user_update_preferences', {
      productivity: { dailyGoal: Number(dailyValue), weeklyGoal: Number(weeklyValue) },
    });
    setSaved(true);
  };

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Goals</h2>
      <p className="mb-4 text-sm text-muted">
        A day counts towards your streak when it reaches the daily goal. Set either to 0 to switch
        it off. Currently {summary.today.completed} done today.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Daily goal"
            type="number"
            min={0}
            max={100}
            value={dailyValue}
            onChange={(e) => {
              setDaily(e.target.value);
              setSaved(false);
            }}
          />
          <TextField
            label="Weekly goal"
            type="number"
            min={0}
            max={700}
            value={weeklyValue}
            onChange={(e) => {
              setWeekly(e.target.value);
              setSaved(false);
            }}
          />
        </div>
        {saved && <Alert tone="success">Saved.</Alert>}
        <Button type="submit">Save goals</Button>
      </form>
    </Card>
  );
}

function VacationCard({ summary }: { summary: ProductivitySummary }) {
  const prefs = usePreferences();
  const send = useSend();
  const [from, setFrom] = useState<string | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const fromValue = from ?? prefs.productivity.vacationFrom ?? '';
  const untilValue = until ?? prefs.productivity.vacationUntil ?? '';
  // The server refuses a range that ends before it starts; say so here instead.
  const backwards = fromValue !== '' && untilValue !== '' && untilValue < fromValue;

  const set = (nextFrom: string, nextUntil: string) =>
    send('user_update_preferences', {
      productivity: { vacationFrom: nextFrom || null, vacationUntil: nextUntil || null },
    });

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Vacation</h2>
      <p className="mb-4 text-sm text-muted">
        While you are away your goals are not missed and your streak holds — it neither breaks nor
        grows. Set both dates to turn it on.
      </p>
      {summary.vacation.active && (
        <Alert tone="info">On vacation until {summary.vacation.until}.</Alert>
      )}
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!backwards) set(fromValue, untilValue);
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="First day"
            type="date"
            value={fromValue}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            label="Last day"
            type="date"
            min={fromValue || undefined}
            value={untilValue}
            onChange={(e) => setUntil(e.target.value)}
          />
        </div>
        {backwards && <Alert>The last day must be on or after the first day.</Alert>}
        <div className="flex gap-2">
          <Button type="submit" disabled={backwards}>
            Start vacation
          </Button>
          {prefs.productivity.vacationUntil !== null && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setFrom('');
                setUntil('');
                set('', '');
              }}
            >
              End vacation
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
