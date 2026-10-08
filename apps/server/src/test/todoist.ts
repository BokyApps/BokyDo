import type { OutboundFetch, OutboundResponse } from '../net/outbound.js';

/**
 * A Todoist full-sync answer in API v1's wire format (snake_case), shaped after the types in
 * Doist's @doist/todoist-sdk. Tests only.
 */
export function todoistFixture() {
  return {
    sync_token: 'abc',
    full_sync: true,
    user: { id: 'u1', full_name: 'Ana Import', email: 'ana@example.com' },
    projects: [
      {
        id: 'p-inbox',
        name: 'Inbox',
        color: 'charcoal',
        parent_id: null,
        child_order: 0,
        inbox_project: true,
        is_deleted: false,
        is_archived: false,
        view_style: 'list',
      },
      {
        id: 'p-work',
        name: 'Work',
        color: 'blue',
        parent_id: null,
        child_order: 1,
        is_deleted: false,
        is_archived: false,
        is_shared: true,
        view_style: 'board',
        is_favorite: true,
      },
      {
        id: 'p-clients',
        name: 'Clients',
        color: 'not-a-colour',
        parent_id: 'p-work',
        child_order: 0,
        is_deleted: false,
      },
      {
        id: 'p-home',
        name: 'Home',
        color: 'green',
        parent_id: null,
        child_order: 2,
        is_deleted: false,
      },
      { id: 'p-gone', name: 'Deleted', parent_id: null, child_order: 3, is_deleted: true },
    ],
    sections: [
      {
        id: 's-doing',
        project_id: 'p-work',
        name: 'Doing',
        section_order: 2,
        is_deleted: false,
        is_archived: false,
      },
      {
        id: 's-todo',
        project_id: 'p-work',
        name: 'To do',
        section_order: 1,
        is_deleted: false,
        is_archived: false,
      },
    ],
    items: [
      {
        id: 't-report',
        project_id: 'p-work',
        section_id: 's-todo',
        parent_id: null,
        content: 'Write report',
        description: 'Quarterly numbers',
        priority: 4,
        labels: ['deep-work', 'two words'],
        due: {
          date: '2026-10-12T09:30:00',
          timezone: null,
          string: 'oct 12 9:30am',
          is_recurring: false,
          lang: 'en',
        },
        deadline: { date: '2026-10-20', lang: 'en' },
        duration: { amount: 45, unit: 'minute' },
        responsible_uid: 'u2',
        child_order: 1,
        checked: false,
        is_deleted: false,
      },
      {
        id: 't-outline',
        project_id: 'p-work',
        section_id: 's-todo',
        parent_id: 't-report',
        content: 'Outline',
        description: '',
        priority: 1,
        labels: [],
        due: null,
        responsible_uid: 'u1',
        child_order: 1,
        checked: false,
        is_deleted: false,
      },
      {
        id: 't-standup',
        project_id: 'p-work',
        section_id: null,
        parent_id: null,
        content: 'Stand-up',
        priority: 2,
        labels: [],
        due: {
          date: '2026-10-09T07:00:00Z',
          timezone: 'Africa/Johannesburg',
          string: 'every weekday 9am',
          is_recurring: true,
        },
        child_order: 0,
        checked: false,
        is_deleted: false,
      },
      {
        id: 't-odd',
        project_id: 'p-home',
        content: 'Water plants\nin the garden',
        priority: 1,
        labels: [],
        due: { date: '2026-10-10', string: 'every full moon', is_recurring: true },
        child_order: 0,
      },
      {
        id: 't-done',
        project_id: 'p-home',
        content: 'Already done',
        checked: true,
        child_order: 1,
      },
      { id: 't-del', project_id: 'p-home', content: 'Deleted', is_deleted: true, child_order: 2 },
      { id: 't-inbox', project_id: 'p-inbox', content: 'Call the bank', child_order: 0 },
    ],
    notes: [
      {
        id: 'n1',
        item_id: 't-report',
        content: 'Use last year as a base',
        posted_at: '2026-10-01T10:00:00Z',
        posted_uid: 'u2',
        is_deleted: false,
      },
      {
        id: 'n2',
        item_id: 't-report',
        content: '',
        posted_at: '2026-10-02T10:00:00Z',
        posted_uid: 'u1',
        file_attachment: { file_name: 'q3.pdf', file_url: 'https://files.todoist.com/x/q3.pdf' },
      },
    ],
    project_notes: [
      {
        id: 'pn1',
        project_id: 'p-work',
        content: 'Team rules',
        posted_uid: 'u1',
        posted_at: '2026-09-01T00:00:00Z',
      },
    ],
    labels: [
      { id: 'l1', name: 'deep-work', color: 'violet', item_order: 0, is_favorite: true },
      { id: 'l2', name: 'two words', color: 'red', item_order: 1 },
    ],
    filters: [
      { id: 'f1', name: 'Focus', query: 'today & @deep-work', color: 'red', item_order: 0 },
      { id: 'f2', name: 'Odd', query: 'added by: me', item_order: 1 },
      { id: 'f3', name: 'Home stuff', query: '#Home | #Garage', item_order: 2 },
    ],
    collaborators: [
      { id: 'u1', full_name: 'Ana Import', email: 'ana@example.com' },
      { id: 'u2', full_name: 'Ben Colleague', email: 'ben@example.com' },
    ],
  };
}

/** An outbound fetch that answers like Todoist and remembers what it was asked. */
export function fakeTodoist(body: () => unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch: OutboundFetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {}, body: String(init.body ?? '') });
    const text = JSON.stringify(body());
    const res: OutboundResponse = {
      status,
      headers: { 'content-type': 'application/json' },
      body: (async function* () {
        yield Buffer.from(text);
      })(),
      text: async () => text,
      json: async () => JSON.parse(text) as unknown,
      cancel: () => undefined,
    };
    return res;
  };
  return { fetch, calls };
}
