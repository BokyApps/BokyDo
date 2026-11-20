// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock('../../lib/toasts.js', () => ({ useToast: () => vi.fn() }));

import { TaskNotesSection } from './TaskNotesSection.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let client: QueryClient;
let container: HTMLDivElement;
let root: Root;
let requests: string[];

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      return new Response(
        JSON.stringify({
          notes: [
            {
              id: 'note-body',
              title: 'Body linked',
              snippet: '',
              tags: [],
              state: 'active',
              pinned: false,
              createdAt: '2026-11-18T10:00:00.000Z',
              updatedAt: '2026-11-18T10:00:00.000Z',
              sources: ['body'],
            },
            {
              id: 'note-manual',
              title: 'Manual linked',
              snippet: '',
              tags: [],
              state: 'active',
              pinned: false,
              createdAt: '2026-11-18T10:00:00.000Z',
              updatedAt: '2026-11-18T10:00:00.000Z',
              sources: ['manual'],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TaskNotesSection taskId="task-1" taskContent="A task" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('P5: task notes use the server-provided link provenance', () => {
  it('renders body/manual labels from sources and fetches no note bodies', async () => {
    await render();
    expect(container.textContent).toContain('Body linked');
    expect(container.textContent).toContain('Manual linked');
    expect(container.textContent).toContain('Linked in the note text');
    expect(container.textContent).toContain('Linked manually');
    expect(container.querySelectorAll('button[aria-label="Unlink note"]')).toHaveLength(1);
    // One request for the task's notes; no /api/v1/notes/<id> detail per note.
    expect(requests).toEqual(['/api/v1/tasks/task-1/notes']);
  });
});
