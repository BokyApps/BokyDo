import { TaskReminders } from './Reminders.js';
import { AssigneePicker } from './Sharing.js';
import { ActivityList, CommentThread } from './Comments.js';
import type { Task } from '@bokydo/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTaskActions } from '../lib/actions.js';
import { makeDue, todayIn } from '../lib/dates.js';
import { localeTag } from '../lib/locale.js';
import { usePreferences, useSyncState, useTimeZone } from '../lib/sync.js';
import { useTaskUI } from '../lib/task-ui.js';
import { childrenOf } from '../lib/views.js';
import { CopyIcon, LinkIcon, TrashIcon } from './icons.js';
import { Markdown } from './Markdown.js';
import { DatePicker, LabelPicker, PriorityPicker, ProjectPicker } from './pickers.js';
import { InlineAdd } from './TaskEditor.js';
import { TaskAssist } from './TaskAssist.js';
import { TaskCheckbox, TaskItem } from './TaskItem.js';
import { Button, Dialog, inputClass } from './ui.js';

const DURATIONS = [0, 15, 30, 45, 60, 90, 120, 180, 240, 480];

/** The task panel: edit everything about one task. Changes save as you go. */
export function TaskDetailDialog() {
  const { t } = useTranslation();
  const ui = useTaskUI();
  const state = useSyncState();
  const task = ui.openTaskId ? state.tasks.get(ui.openTaskId) : undefined;
  // If the task disappears (deleted, unshared), close.
  useEffect(() => {
    if (ui.openTaskId && state.user && !state.tasks.has(ui.openTaskId)) ui.openTask(null);
  }, [ui, state]);
  return (
    <Dialog
      open={Boolean(task)}
      onClose={() => ui.openTask(null)}
      title={task?.content ?? t('task.untitled')}
      wide
    >
      {task && <TaskDetail key={task.id} task={task} />}
    </Dialog>
  );
}

function TaskDetail({ task }: { task: Task }) {
  const { t } = useTranslation();
  const state = useSyncState();
  const prefs = usePreferences();
  const today = todayIn(useTimeZone());
  const actions = useTaskActions();
  const ui = useTaskUI();
  const [content, setContent] = useState(task.content);
  const [description, setDescription] = useState(task.description);
  const [editingDescription, setEditingDescription] = useState(false);
  const project = state.projects.get(task.projectId);
  const readOnly = project ? !['owner', 'admin', 'editor'].includes(project.role) : true;
  const parent = task.parentId ? state.tasks.get(task.parentId) : undefined;
  const kids = childrenOf(state, task.id);
  const kidIds = kids.map((k) => k.id);

  // Pick up changes made elsewhere (another device, a collaborator) without clobbering edits.
  const [seen, setSeen] = useState({ content: task.content, description: task.description });
  if (seen.content !== task.content || seen.description !== task.description) {
    setSeen({ content: task.content, description: task.description });
    if (seen.content !== task.content) setContent(task.content);
    if (seen.description !== task.description && !editingDescription)
      setDescription(task.description);
  }

  const saveContent = () => {
    const v = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    if (v && v !== task.content) actions.update(task.id, { content: v });
    else setContent(task.content);
  };
  const saveDescription = () => {
    setEditingDescription(false);
    if (description !== task.description) actions.update(task.id, { description });
  };

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <div className="min-w-0 flex-1 space-y-4">
        {parent && (
          <button
            type="button"
            className="text-xs text-muted hover:text-accent"
            onClick={() => ui.openTask(parent.id)}
          >
            ↑ {parent.content}
          </button>
        )}
        <div className="flex items-start gap-3">
          <TaskCheckbox
            task={task}
            onToggle={() =>
              readOnly
                ? undefined
                : task.isCompleted
                  ? actions.uncomplete(task)
                  : actions.complete([task])
            }
          />
          <textarea
            aria-label={t('task.taskName')}
            readOnly={readOnly}
            className={`w-full resize-none bg-transparent text-lg font-semibold focus:outline-none ${task.isCompleted ? 'text-muted line-through' : ''}`}
            rows={Math.min(4, Math.ceil(content.length / 50) || 1)}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onBlur={saveContent}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        </div>
        {!task.isCompleted && <TaskAssist task={task} readOnly={readOnly} />}
        <div>
          {editingDescription ? (
            <textarea
              aria-label={t('task.description')}
              autoFocus
              className={`${inputClass} min-h-32 font-mono text-xs`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={saveDescription}
              placeholder={t('task.descriptionPlaceholder')}
            />
          ) : task.description ? (
            // The text (with its links) is ordinary content; editing is its own button, so no
            // control sits inside another. Clicking the text also edits, for pointer users.
            <div
              className={`group/desc relative rounded-lg ${readOnly ? '' : 'cursor-text hover:bg-surface-alt'}`}
              onClick={() => !readOnly && setEditingDescription(true)}
            >
              <div className="p-2">
                <Markdown text={task.description} />
              </div>
              {!readOnly && (
                <button
                  type="button"
                  className="absolute top-1 right-1 rounded px-2 py-1 text-xs text-muted opacity-0 group-focus-within/desc:opacity-100 group-hover/desc:opacity-100 hover:text-fg focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingDescription(true);
                  }}
                >
                  {t('task.editDescription')}
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              disabled={readOnly}
              className="w-full rounded-lg p-2 text-left text-sm text-muted hover:bg-surface-alt disabled:hover:bg-transparent"
              onClick={() => setEditingDescription(true)}
            >
              {t('task.addDescription')}
            </button>
          )}
        </div>
        <section aria-label={t('task.subtasks')}>
          <h3 className="mb-1 text-sm font-semibold">
            {t('task.subtasks')}{' '}
            {kids.length > 0 && (
              <span className="font-normal text-muted">
                {kids.filter((k) => k.isCompleted).length}/{kids.length}
              </span>
            )}
          </h3>
          <ul>
            {kids.map((k) => (
              <TaskItem key={k.id} task={k} orderedIds={kidIds} />
            ))}
          </ul>
          {!readOnly && <InlineAdd defaults={{ parentId: task.id }} label={t('task.addSubtask')} />}
        </section>
        <TaskTalk task={task} />
      </div>

      <aside className="w-full shrink-0 space-y-4 rounded-xl bg-surface-alt/60 p-4 text-sm md:w-64">
        <Prop label={t('task.project')}>
          {readOnly ? (
            project?.name
          ) : (
            <ProjectPicker
              projectId={task.projectId}
              sectionId={task.sectionId}
              onChange={(to, p) => actions.move([task], to, p.isInbox ? t('task.inbox') : p.name)}
            />
          )}
        </Prop>
        <Prop label={t('task.assignee')}>
          <AssigneePicker task={task} readOnly={readOnly} />
        </Prop>
        <Prop label={t('task.date')}>
          <DatePicker value={task.due} onChange={(d) => actions.update(task.id, { due: d })} />
        </Prop>
        <Prop label={t('task.reminders')}>
          <TaskReminders task={task} />
        </Prop>
        <Prop label={t('task.deadline')}>
          <DatePicker
            value={task.deadline ? makeDue(task.deadline, null, today, prefs) : null}
            onChange={(d) => actions.update(task.id, { deadline: d?.date ?? null })}
            label={t('task.deadline')}
          />
        </Prop>
        <Prop label={t('task.duration')}>
          <select
            aria-label={t('task.duration')}
            className={`${inputClass} py-1`}
            value={task.durationMinutes ?? 0}
            disabled={readOnly}
            onChange={(e) =>
              actions.update(task.id, { durationMinutes: Number(e.target.value) || null })
            }
          >
            {DURATIONS.map((m) => (
              <option key={m} value={m}>
                {m === 0
                  ? t('task.none')
                  : m < 60
                    ? t('task.minutes', { count: m })
                    : t('task.hours', { count: m / 60 })}
              </option>
            ))}
          </select>
        </Prop>
        <Prop label={t('task.priorityLabel')}>
          <PriorityPicker
            value={task.priority}
            onChange={(p) => actions.update(task.id, { priority: p })}
          />
        </Prop>
        <Prop label={t('task.labels')}>
          <LabelPicker
            value={task.labels}
            onChange={(labels) => actions.update(task.id, { labels })}
          />
        </Prop>
        <p className="text-xs text-muted">
          {t('task.added', { date: new Date(task.createdAt).toLocaleString(localeTag()) })}
        </p>
        {!readOnly && (
          <div className="flex flex-wrap gap-1 border-t border-line pt-3">
            <Button variant="ghost" onClick={() => actions.duplicate(task)}>
              <CopyIcon /> {t('task.duplicate')}
            </Button>
            <Button variant="ghost" onClick={() => actions.copyLink(task)}>
              <LinkIcon /> {t('task.link')}
            </Button>
            <Button
              variant="ghost"
              className="text-danger"
              onClick={() => void actions.remove([task]).then((ok) => ok && ui.openTask(null))}
            >
              <TrashIcon /> {t('task.delete')}
            </Button>
          </div>
        )}
      </aside>
    </div>
  );
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}

/** Comments and activity for one task. */
function TaskTalk({ task }: { task: Task }) {
  const { t } = useTranslation();
  const state = useSyncState();
  const [tab, setTab] = useState<'comments' | 'activity'>('comments');
  const count = [...state.comments.values()].filter((c) => c.taskId === task.id).length;
  return (
    <section aria-label={t('task.commentsAndActivity')} className="border-t border-line pt-3">
      <div role="tablist" className="mb-3 flex gap-1 text-sm">
        {(['comments', 'activity'] as const).map((tabKey) => (
          <button
            key={tabKey}
            type="button"
            role="tab"
            aria-selected={tab === tabKey}
            onClick={() => setTab(tabKey)}
            className={`rounded-md px-3 py-1 ${tab === tabKey ? 'bg-surface-alt font-medium' : 'text-muted hover:text-fg'}`}
          >
            {tabKey === 'comments'
              ? `${t('task.comments')}${count ? ` (${count})` : ''}`
              : t('task.activity')}
          </button>
        ))}
      </div>
      {tab === 'comments' ? (
        <CommentThread projectId={task.projectId} taskId={task.id} />
      ) : (
        <ActivityList taskId={task.id} />
      )}
    </section>
  );
}
