import { describe, expect, it } from 'vitest';
import type { OutboundFetch, OutboundResponse } from '../net/outbound.js';
import {
  fetchTodoistCompleted,
  hasCompletionDate,
  monthsBetween,
  TODOIST_COMPLETED_MAX_MONTHS,
  TODOIST_COMPLETED_URL,
  TodoistError,
  type TodoistCompletedTask,
} from './todoist-client.js';

/**
 * The completed-items reader (W11a-c1). These run without a database, so the paging, the
 * caps and the window rule are checked directly; the import flow they feed is tested with a
 * database in todoist-import.test.ts.
 */

function item(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    project_id: 'p-work',
    content: `Task ${id}`,
    priority: 4,
    labels: [],
    child_order: 0,
    completed_at: '2026-09-16T10:00:00Z',
    is_deleted: false,
    ...extra,
  };
}

/** An outbound that answers pages in order, and remembers every request. */
function paged(pages: { items: unknown[]; next_cursor: string | null }[]) {
  const seen: string[] = [];
  let i = 0;
  const fetch: OutboundFetch = async (url, init = {}) => {
    seen.push(String(url));
    const page = pages[Math.min(i, pages.length - 1)] ?? { items: [], next_cursor: null };
    i += 1;
    const text = JSON.stringify(page);
    const res: OutboundResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: (async function* () {
        yield Buffer.from(text);
      })(),
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
      cancel: () => undefined,
      ...(init.signal ? {} : {}),
    };
    return res;
  };
  return { fetch, seen };
}

const token = '0123456789abcdef0123456789abcdef01234567';
const since = new Date('2026-07-01T00:00:00Z');
const until = new Date('2026-09-30T00:00:00Z');

describe('Todoist completed items', () => {
  it('reads one page and stops when there is no next cursor', async () => {
    const fake = paged([{ items: [item('a'), item('b')], next_cursor: null }]);
    const tasks = await fetchTodoistCompleted(fake.fetch, token, { since, until });
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(fake.seen).toHaveLength(1);
    // The window and the page size travel as query parameters.
    expect(fake.seen[0]).toContain(`${TODOIST_COMPLETED_URL}?`);
    expect(fake.seen[0]).toContain('since=2026-07-01T00%3A00%3A00.000Z');
    expect(fake.seen[0]).toContain('until=2026-09-30T00%3A00%3A00.000Z');
    expect(fake.seen[0]).toContain('limit=200');
  });

  it('follows the cursor and dedupes what the pages repeat', async () => {
    const fake = paged([
      { items: [item('a')], next_cursor: 'c1' },
      { items: [item('a'), item('b')], next_cursor: 'c2' },
      { items: [item('c')], next_cursor: null },
    ]);
    const tasks = await fetchTodoistCompleted(fake.fetch, token, { since, until });
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(fake.seen).toHaveLength(3);
    expect(fake.seen[1]).toContain('cursor=c1');
    expect(fake.seen[2]).toContain('cursor=c2');
  });

  it('refuses a window longer than Todoist allows before any call', async () => {
    const fake = paged([{ items: [item('a')], next_cursor: null }]);
    await expect(
      fetchTodoistCompleted(fake.fetch, token, {
        since: new Date('2026-01-01T00:00:00Z'),
        until: new Date('2026-09-30T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ reason: 'window_too_long' });
    expect(fake.seen).toHaveLength(0);

    // Exactly the cap is fine.
    const ok = paged([{ items: [item('a')], next_cursor: null }]);
    await fetchTodoistCompleted(ok.fetch, token, {
      since: new Date('2026-07-01T00:00:00Z'),
      until: new Date('2026-09-30T00:00:00Z'),
    });
    expect(ok.seen).toHaveLength(1);
  });

  it('gives up rather than paging forever', async () => {
    const fake = paged([{ items: [item('a')], next_cursor: 'c1' }]);
    await expect(fetchTodoistCompleted(fake.fetch, token, { since, until })).rejects.toMatchObject({
      reason: 'too_many_pages',
    });
  });

  it('keeps only what the planner needs: no checked filter, no deleted rows', async () => {
    const fake = paged([
      {
        items: [
          item('a', { completed_by_uid: 'u2' }),
          // Deleted after the fact: not ours to keep.
          item('gone', { is_deleted: true }),
        ],
        next_cursor: null,
      },
    ]);
    const [task] = await fetchTodoistCompleted(fake.fetch, token, { since, until });
    expect(task?.id).toBe('a');
    expect(task?.completedByUid).toBe('u2');
    expect(task?.completedAt.toISOString()).toBe('2026-09-16T10:00:00.000Z');
  });

  it('distinguishes a window past the cap from a broken answer', async () => {
    const bad: OutboundFetch = async () => {
      const res = {
        status: 400,
        headers: {},
        body: (async function* (): AsyncGenerator<Buffer> {
          yield Buffer.from('{}');
        })(),
        text: async () => '{}',
        json: async () => ({}) as unknown,
        cancel: () => undefined,
      } as OutboundResponse;
      return res;
    };
    await expect(fetchTodoistCompleted(bad, token, { since, until })).rejects.toMatchObject({
      reason: 'window_too_long',
    });
  });
});

describe('completion dates', () => {
  const task = (completedAt: string): TodoistCompletedTask =>
    ({
      id: 'x',
      projectId: 'p',
      sectionId: null,
      parentId: null,
      content: 'x',
      description: '',
      priority: 4,
      labels: [],
      due: null,
      deadline: null,
      duration: null,
      responsibleUid: null,
      order: 0,
      completedAt: new Date(completedAt),
      completedByUid: null,
    }) as TodoistCompletedTask;

  it('a missing or unreadable completion time is not one we can keep', () => {
    expect(hasCompletionDate(task('2026-09-16T10:00:00Z'))).toBe(true);
    expect(hasCompletionDate(task('not a date'))).toBe(false);
  });

  it('counts whole months a window covers', () => {
    expect(monthsBetween(new Date('2026-08-01'), new Date('2026-09-01'))).toBe(1);
    // Three months to the day is at the cap; one day over it is refused.
    expect(monthsBetween(new Date('2026-07-01'), new Date('2026-10-01'))).toBe(
      TODOIST_COMPLETED_MAX_MONTHS,
    );
    expect(monthsBetween(new Date('2026-07-01'), new Date('2026-10-02'))).toBe(
      TODOIST_COMPLETED_MAX_MONTHS + 1,
    );
    expect(monthsBetween(new Date('2026-07-01'), new Date('2026-09-30'))).toBe(3);
    expect(monthsBetween(new Date('2026-09-30'), new Date('2026-09-01'))).toBe(0);
  });

  it('TodoistError carries the reason the route maps to a status', () => {
    expect(new TodoistError('unauthorized').reason).toBe('unauthorized');
  });
});
