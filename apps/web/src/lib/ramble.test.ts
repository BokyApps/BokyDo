import {
  rambleCommitRequestSchema,
  rambleExtractRequestSchema,
  RAMBLE_LIMITS,
  type Project,
  type RambleDraftTask,
  type RambleIssue,
  type RambleResolution,
  type RambleResolvedTask,
} from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import {
  appendSpoken,
  audioUploadType,
  buildCommitBody,
  changeKinds,
  chunkSeconds,
  commitFailure,
  commitReasonText,
  createSerialQueue,
  draftForExtract,
  draftProblem,
  issueText,
  mergeExtraction,
  projectFor,
  reconcileOverrides,
  rambleStatus,
  stripResolved,
  summarizeOps,
  textProblem,
  visibleIssues,
  writableProjects,
} from './ramble.js';

const resolution = (over: Partial<RambleResolution> = {}): RambleResolution => ({
  projectId: null,
  sectionId: null,
  due: null,
  labels: [],
  assigneeId: null,
  issues: [],
  ...over,
});

const task = (
  ref: string,
  content: string,
  extra: Partial<RambleDraftTask> = {},
  res: Partial<RambleResolution> = {},
): RambleResolvedTask => ({ ref, content, ...extra, resolved: resolution(res) });

const draftOf = (t: RambleResolvedTask): RambleDraftTask => stripResolved(t);

const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({
  id,
  name,
  color: 'blue',
  parentId: null,
  childOrder: id,
  viewStyle: 'list',
  isInbox: false,
  isArchived: false,
  isFavorite: false,
  role: 'owner',
  workspaceId: null,
  folderId: null,
  visibility: 'restricted',
  updatedAt: '',
  ...extra,
});

describe('stripResolved and the extract body', () => {
  it('drops only the resolved part of a task', () => {
    const t = task('d1', 'Call Ana', { project: 'Work', priority: 2 }, { issues: ['new_label'] });
    expect(stripResolved(t)).toEqual({
      ref: 'd1',
      content: 'Call Ana',
      project: 'Work',
      priority: 2,
    });
  });

  it('builds a body the extract endpoint accepts (its schema is strict)', () => {
    const draft = [task('d1', 'Buy milk', { due: 'tomorrow' }), task('d2', 'Ring the bank')];
    const body = { text: 'and also the bank', draft: draftForExtract(draft) };
    expect(rambleExtractRequestSchema.safeParse(body).success).toBe(true);
  });
});

describe('buildCommitBody', () => {
  it('attaches a project only where the user picked one', () => {
    const draft = [task('d1', 'A', { project: 'Nope' }), task('d2', 'B')];
    const body = buildCommitBody(draft, { d1: '00000000-0000-4000-8000-000000000001' });
    expect(body.tasks[0]).toEqual({
      ref: 'd1',
      content: 'A',
      project: 'Nope',
      projectId: '00000000-0000-4000-8000-000000000001',
    });
    expect(body.tasks[1]).toEqual({ ref: 'd2', content: 'B' });
  });

  it('is a valid commit request, with no resolved field left in', () => {
    const draft = [
      task('d1', 'Pay rent', { due: 'on the 1st', labels: ['home'] }, { issues: ['new_label'] }),
    ];
    const body = buildCommitBody(draft, {});
    expect(rambleCommitRequestSchema.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain('resolved');
  });
});

describe('mergeExtraction', () => {
  const sent = [draftOf(task('d1', 'Milk')), draftOf(task('d2', 'Bread'))];

  it('takes the server answer as it is when nothing changed meanwhile', () => {
    const received = [task('d1', 'Oat milk'), task('d2', 'Bread'), task('d3', 'Eggs')];
    const current = [task('d1', 'Milk'), task('d2', 'Bread')];
    expect(mergeExtraction({ sent, received, current })).toEqual(received);
  });

  it('keeps a task the user removed while the call was in flight removed', () => {
    const received = [task('d1', 'Milk'), task('d2', 'Bread')];
    const current = [task('d1', 'Milk')];
    expect(mergeExtraction({ sent, received, current }).map((t) => t.ref)).toEqual(['d1']);
  });

  it('keeps a name the user typed while the call was in flight', () => {
    const received = [task('d1', 'Milk and cream'), task('d2', 'Bread')];
    const current = [task('d1', 'Whole milk'), task('d2', 'Bread')];
    expect(mergeExtraction({ sent, received, current })[0]?.content).toBe('Whole milk');
  });
});

describe('reconcileOverrides', () => {
  const sent = [draftOf(task('d1', 'Milk', { project: 'Shop' })), draftOf(task('d2', 'Bread'))];

  it('keeps a pick while the project name is unchanged', () => {
    const next = [task('d1', 'Milk', { project: 'Shop' }), task('d2', 'Bread')];
    expect(reconcileOverrides({ d1: 'p1' }, sent, next)).toEqual({ d1: 'p1' });
  });

  it('drops a pick when the model moved the task to another project', () => {
    const next = [task('d1', 'Milk', { project: 'Garden' }), task('d2', 'Bread')];
    expect(reconcileOverrides({ d1: 'p1' }, sent, next)).toEqual({});
  });

  it('drops a pick for a task that is no longer in the draft', () => {
    const next = [task('d2', 'Bread')];
    expect(reconcileOverrides({ d1: 'p1' }, sent, next)).toEqual({});
  });
});

describe('projectFor and visibleIssues', () => {
  it('prefers the pick over the resolved project, and falls back to it', () => {
    const t = task('d1', 'Milk', {}, { projectId: 'shop' });
    expect(projectFor(t, { d1: 'pick' })).toBe('pick');
    expect(projectFor(t, {})).toBe('shop');
    expect(projectFor(task('d2', 'X'), {})).toBeNull();
  });

  it('hides the unknown-project issue once the user has picked a project', () => {
    const issues: RambleIssue[] = ['unknown_project', 'unparsed_due'];
    expect(visibleIssues(issues, true)).toEqual(['unparsed_due']);
    expect(visibleIssues(issues, false)).toEqual(issues);
  });

  it('has a plain sentence for every issue', () => {
    const all: RambleIssue[] = [
      'unknown_project',
      'unknown_section',
      'unknown_assignee',
      'unparsed_due',
      'new_label',
    ];
    for (const issue of all) expect(issueText(issue).length).toBeGreaterThan(5);
    expect(issueText('unknown_project')).toBe('Project not found, will go to Inbox');
    expect(issueText('unparsed_due')).toBe("Couldn't read the date");
    expect(issueText('new_label')).toBe('New label');
  });
});

describe('changes from the last extraction', () => {
  it('marks added and changed tasks, and forgets a task that was removed', () => {
    const kinds = changeKinds([
      { op: 'add', ref: 'd3' },
      { op: 'update', ref: 'd1' },
      { op: 'update', ref: 'd1' },
      { op: 'update', ref: 'd2' },
      { op: 'remove', ref: 'd2' },
    ]);
    expect([...kinds]).toEqual([
      ['d3', 'added'],
      ['d1', 'changed'],
    ]);
  });

  it('summarises operations in words, leaving out zero counts', () => {
    expect(
      summarizeOps([
        { op: 'add', ref: 'd1' },
        { op: 'add', ref: 'd2' },
        { op: 'remove', ref: 'd3' },
      ]),
    ).toBe('2 added, 1 removed');
    expect(summarizeOps([])).toBe('');
  });
});

describe('writableProjects', () => {
  it('lists projects the user can write to, Inbox first, without archived ones', () => {
    const list = writableProjects([
      project('work', 'Work'),
      project('inbox', 'Inbox', { isInbox: true }),
      project('plans', 'Plans', { role: 'viewer' }),
      project('old', 'Old', { isArchived: true }),
      project('team', 'Team', { role: 'editor' }),
      project('admin', 'Admin', { role: 'admin' }),
    ]);
    expect(list).toEqual([
      { id: 'inbox', label: 'Inbox' },
      { id: 'admin', label: 'Admin' },
      { id: 'team', label: 'Team' },
      { id: 'work', label: 'Work' },
    ]);
  });
});

describe('draft problems and text limits', () => {
  it('reports a task with no name', () => {
    expect(draftProblem([task('d1', '   ')])).toBe('Every task needs a name.');
    expect(draftProblem([task('d1', 'Milk')])).toBeNull();
  });

  it('refuses text over the server limit, counting trimmed length', () => {
    expect(textProblem('x'.repeat(RAMBLE_LIMITS.maxTextChars))).toBeNull();
    expect(textProblem(`${'x'.repeat(RAMBLE_LIMITS.maxTextChars)}   `)).toBeNull();
    expect(textProblem('x'.repeat(RAMBLE_LIMITS.maxTextChars + 1))).not.toBeNull();
  });

  it('appends dictated words with one space', () => {
    expect(appendSpoken('', 'buy milk')).toBe('buy milk');
    expect(appendSpoken('buy milk  ', ' and eggs')).toBe('buy milk and eggs');
    expect(appendSpoken('buy milk', '   ')).toBe('buy milk');
  });
});

describe('rambleStatus', () => {
  const base = {
    listening: false,
    transcribing: false,
    extracting: false,
    count: 0,
    lastChange: '',
  };

  it('says how many tasks are in the draft', () => {
    expect(rambleStatus({ ...base, count: 1 })).toBe('1 task in draft.');
    expect(rambleStatus({ ...base, count: 3, lastChange: '2 added' })).toBe(
      '3 tasks in draft. Last change: 2 added.',
    );
  });

  it('names work in progress first, and leaves the last change out while busy', () => {
    expect(rambleStatus({ ...base, listening: true, count: 2, lastChange: '1 added' })).toBe(
      'Listening. 2 tasks in draft. Last change: 1 added.',
    );
    expect(
      rambleStatus({
        ...base,
        transcribing: true,
        extracting: true,
        count: 2,
        lastChange: '1 added',
      }),
    ).toBe('Transcribing… Extracting… 2 tasks in draft.');
  });
});

describe('the serial queue', () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('runs one job at a time, in order', async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    const first = deferred<string>();
    const a = queue.run(async () => {
      log.push('a start');
      await first.promise;
      log.push('a end');
      return 'a';
    });
    const b = queue.run(async () => {
      log.push('b start');
      return 'b';
    });
    await Promise.resolve();
    expect(log).toEqual(['a start']);
    first.resolve('go');
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(log).toEqual(['a start', 'a end', 'b start']);
  });

  it('keeps running the queue after a job fails', async () => {
    const queue = createSerialQueue();
    const failed = queue.run(async () => {
      throw new Error('boom');
    });
    const next = queue.run(async () => 'next');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('next');
  });
});

describe('commit failures and reasons', () => {
  it('reads the ref and reason from a not_created answer', () => {
    expect(commitFailure({ error: 'not_created', ref: 'd2', reason: 'forbidden' })).toEqual({
      ref: 'd2',
      reason: 'forbidden',
    });
    expect(commitFailure({ error: 'not_created' })).toBeNull();
    expect(commitFailure(null)).toBeNull();
  });

  it('says what went wrong in plain words, with a fallback', () => {
    expect(commitReasonText('forbidden')).toBe("You can't add tasks to that project.");
    expect(commitReasonText('mystery')).toBe("That task couldn't be saved.");
    expect(commitReasonText(null)).toBe("That task couldn't be saved.");
  });
});

describe('audio helpers', () => {
  it('uploads the base content type, without codec parameters', () => {
    expect(audioUploadType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(audioUploadType('Audio/MP4')).toBe('audio/mp4');
    expect(audioUploadType('')).toBe('audio/webm');
  });

  it('rounds the chunk length to the nearest second, within the server limit', () => {
    expect(chunkSeconds(0)).toBe(1);
    expect(chunkSeconds(4_150)).toBe(4);
    expect(chunkSeconds(4_600)).toBe(5);
    expect(chunkSeconds(10 * 60_000)).toBe(RAMBLE_LIMITS.maxAudioSeconds);
  });
});

describe('the commit request contract', () => {
  it('rejects a draft with a bad ref, so the client never sends one', () => {
    const body = buildCommitBody([task('x1', 'Bad ref')], {});
    expect(rambleCommitRequestSchema.safeParse(body).success).toBe(false);
  });
});
