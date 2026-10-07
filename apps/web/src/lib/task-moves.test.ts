import type { Task } from '@bokydo/shared';
import type { SyncState } from '@bokydo/sync-client';
import { describe, expect, it } from 'vitest';
import { storeWith } from './test-store.js';
import { MAX_SUBTASK_DEPTH, taskMoves, type Placement } from './task-moves.js';
import { byOrder } from './views.js';

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const PROJECT = id();
const SECTION = id();

type Row = { id: string; content: string; key: string; parent?: string; done?: boolean };

async function listWith(rows: Row[]): Promise<SyncState> {
  return storeWith([
    { type: 'project_add', args: { id: PROJECT, name: 'P' } },
    {
      type: 'section_add',
      args: { id: SECTION, projectId: PROJECT, name: 'S', sectionOrder: 'a0' },
    },
    ...rows.flatMap((r) => [
      {
        type: 'task_add' as const,
        args: {
          id: r.id,
          projectId: PROJECT,
          content: r.content,
          childOrder: r.key,
          ...(r.parent ? { parentId: r.parent } : { sectionId: SECTION }),
        },
      },
      ...(r.done ? [{ type: 'task_complete' as const, args: { id: r.id } }] : []),
    ]),
  ]);
}

/** Apply a placement the way the app does (`actions.place`), then read the sibling order. */
async function afterMove(
  rows: Row[],
  moved: string,
  pick: (m: ReturnType<typeof taskMoves>) => Placement | null,
) {
  const state = await listWith(rows);
  const task = state.tasks.get(moved) as Task;
  const to = pick(taskMoves(state, task));
  if (!to) throw new Error('move not offered');
  const next = await storeWith(
    [
      to.parentId
        ? {
            type: 'task_move',
            args: { id: moved, parentId: to.parentId, childOrder: to.childOrder },
          }
        : {
            type: 'task_move',
            args: {
              id: moved,
              projectId: to.projectId,
              sectionId: to.sectionId,
              parentId: null,
              childOrder: to.childOrder,
            },
          },
    ],
    [
      { type: 'project_add', args: { id: PROJECT, name: 'P' } },
      {
        type: 'section_add',
        args: { id: SECTION, projectId: PROJECT, name: 'S', sectionOrder: 'a0' },
      },
      ...rows.map((r) => ({
        type: 'task_add' as const,
        args: {
          id: r.id,
          projectId: PROJECT,
          content: r.content,
          childOrder: r.key,
          ...(r.parent ? { parentId: r.parent } : { sectionId: SECTION }),
        },
      })),
      ...rows
        .filter((r) => r.done)
        .map((r) => ({ type: 'task_complete' as const, args: { id: r.id } })),
    ],
  );
  const parentOf = next.tasks.get(moved)?.parentId ?? null;
  return {
    state: next,
    siblings: [...next.tasks.values()]
      .filter((t) => t.parentId === parentOf && t.projectId === PROJECT)
      .sort(byOrder)
      .map((t) => t.content),
  };
}

const [A, B, C] = [id(), id(), id()];
const three: Row[] = [
  { id: A, content: 'A', key: 'a0' },
  { id: B, content: 'B', key: 'a1' },
  { id: C, content: 'C', key: 'a2' },
];

describe('taskMoves', () => {
  it('offers up and down only where there is somewhere to go', async () => {
    const state = await listWith(three);
    const moves = (t: string) => taskMoves(state, state.tasks.get(t) as Task);
    expect(moves(A).up).toBeNull();
    expect(moves(A).down).not.toBeNull();
    expect(moves(B).up).not.toBeNull();
    expect(moves(B).down).not.toBeNull();
    expect(moves(C).down).toBeNull();
    expect(moves(C).up).not.toBeNull();
  });

  it('moves a task one place up or down, like a drag would', async () => {
    expect((await afterMove(three, B, (m) => m.up)).siblings).toEqual(['B', 'A', 'C']);
    expect((await afterMove(three, B, (m) => m.down)).siblings).toEqual(['A', 'C', 'B']);
    expect((await afterMove(three, A, (m) => m.down)).siblings).toEqual(['B', 'A', 'C']);
    expect((await afterMove(three, C, (m) => m.up)).siblings).toEqual(['A', 'C', 'B']);
  });

  it('steps over completed tasks instead of stopping on them', async () => {
    const rows: Row[] = [
      { id: A, content: 'A', key: 'a0' },
      { id: B, content: 'B', key: 'a1', done: true },
      { id: C, content: 'C', key: 'a2' },
    ];
    const state = await listWith(rows);
    expect(taskMoves(state, state.tasks.get(A) as Task).down).not.toBeNull();
    const { siblings } = await afterMove(rows, A, (m) => m.down);
    expect(siblings.filter((s) => s !== 'B')).toEqual(['C', 'A']);
  });

  it('makes a task a sub-task of the one above, and back out again', async () => {
    const indented = await afterMove(three, B, (m) => m.indent);
    expect(indented.state.tasks.get(B)?.parentId).toBe(A);
    expect(indented.state.tasks.get(B)?.sectionId).toBe(SECTION);
    // Back out: it lands right after its former parent, not at the end.
    const out = await afterMove(
      [...three.map((r) => (r.id === B ? { ...r, parent: A, key: 'a0' } : r))],
      B,
      (m) => m.outdent,
    );
    expect(out.state.tasks.get(B)?.parentId).toBeNull();
    expect(out.siblings).toEqual(['A', 'B', 'C']);
  });

  it('puts a new sub-task after the existing ones', async () => {
    const kid = id();
    const rows: Row[] = [...three, { id: kid, content: 'kid', key: 'a0', parent: A }];
    const { state } = await afterMove(rows, B, (m) => m.indent);
    const kids = [...state.tasks.values()]
      .filter((t) => t.parentId === A)
      .sort(byOrder)
      .map((t) => t.content);
    expect(kids).toEqual(['kid', 'B']);
  });

  it('never offers indent for the first task or outdent for a top-level one', async () => {
    const state = await listWith(three);
    expect(taskMoves(state, state.tasks.get(A) as Task).indent).toBeNull();
    expect(taskMoves(state, state.tasks.get(B) as Task).outdent).toBeNull();
  });

  it('stops offering indent where the server would refuse the nesting', async () => {
    const chain = Array.from({ length: MAX_SUBTASK_DEPTH + 1 }, () => id());
    const sibling = id();
    const rows: Row[] = [
      ...chain.map((cid, i) => ({
        id: cid,
        content: `L${i}`,
        key: 'a0',
        ...(i > 0 ? { parent: chain[i - 1] as string } : {}),
      })),
      { id: sibling, content: 'S', key: 'a1', parent: chain[MAX_SUBTASK_DEPTH - 1] as string },
    ];
    const state = await listWith(rows);
    // The sibling's task above is at the deepest allowed level, so it can't take a child.
    expect(taskMoves(state, state.tasks.get(sibling) as Task).indent).toBeNull();
    // One level up there is still room.
    const shallow = await listWith([
      ...rows.slice(0, MAX_SUBTASK_DEPTH),
      { id: sibling, content: 'S', key: 'a1', parent: chain[MAX_SUBTASK_DEPTH - 2] as string },
    ]);
    expect(taskMoves(shallow, shallow.tasks.get(sibling) as Task).indent).not.toBeNull();
  });
});
