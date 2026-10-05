import type { Project, Section, Task } from '@bokydo/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ArchiveIcon,
  ChevronIcon,
  EditIcon,
  MoreIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
} from '../components/icons.js';
import { Board, orderBetween } from '../components/Board.js';
import { CalendarView } from '../components/Calendar.js';
import { ProjectDialog } from '../components/ProjectDialog.js';
import { InlineAdd } from '../components/TaskEditor.js';
import { PlainTaskList, SortableTaskList, TaskDnd } from '../components/TaskTree.js';
import { Alert, Button, inputClass, MenuItem, Popover } from '../components/ui.js';
import { EmptyState, Page, ViewHeader } from '../components/ViewHeader.js';
import { api } from '../lib/api.js';
import { useConfirm } from '../lib/confirm.js';
import { newId, useSend, useSyncState } from '../lib/sync.js';
import { useTaskUI } from '../lib/task-ui.js';
import { useTaskActions } from '../lib/actions.js';
import { useViewOptions, type Layout } from '../lib/view-options.js';
import { liveTasks, projectTasks, sectionsOf } from '../lib/views.js';

export function InboxPage() {
  const state = useSyncState();
  const inboxId = state.user?.inboxProjectId;
  if (!inboxId) return null;
  return <ProjectView projectId={inboxId} />;
}

export function ProjectView({ projectId }: { projectId: string }) {
  const state = useSyncState();
  const project = state.projects.get(projectId);
  const ui = useTaskUI();
  const send = useSend();
  const actions = useTaskActions();
  const { setViewDefaults } = ui;
  const [options, setOptions] = useViewOptions(`project.${projectId}`);
  const [editing, setEditing] = useState(false);
  useEffect(() => setViewDefaults({ projectId }), [projectId, setViewDefaults]);

  if (!state.user) return null;
  if (!project)
    return (
      <Page>
        <EmptyState title="Project not found">
          It may have been deleted, or it's no longer shared with you.
        </EmptyState>
      </Page>
    );

  const canEdit = ['owner', 'admin', 'editor'].includes(project.role) && !project.isArchived;
  // The layout is part of the project (synced, shared); read-only members choose their own.
  const layout: Layout = canEdit ? project.viewStyle : options.layout;
  const setLayout = (next: Layout) =>
    canEdit
      ? send('project_update', { id: project.id, viewStyle: next })
      : setOptions({ layout: next });
  const groups = projectTasks(state, projectId);
  const sections = sectionsOf(state, projectId);
  const orderedIds = [...groups.values()].flat().map((t) => t.id);
  const empty = orderedIds.length === 0 && sections.length === 0;

  return (
    <Page wide={layout !== 'list'}>
      <ViewHeader
        title={project.isInbox ? 'Inbox' : project.name}
        options={options}
        setOptions={setOptions}
        allow={{ completed: layout === 'list' }}
        layout={{ value: layout, onChange: setLayout }}
        actions={
          !project.isInbox && <ProjectMenu project={project} onEdit={() => setEditing(true)} />
        }
      />
      {project.isArchived && (
        <div className="mb-4">
          <Alert tone="info">This project is archived and read-only.</Alert>
        </div>
      )}
      {layout === 'board' && (
        <Board
          columns={[
            ...((groups.get(null) ?? []).length > 0 || sections.length === 0
              ? [
                  {
                    id: 'none',
                    title: '(No section)',
                    tasks: groups.get(null) ?? [],
                    addDefaults: { projectId, sectionId: null },
                  },
                ]
              : []),
            ...sections.map((s) => ({
              id: s.id,
              title: <SectionHeading section={s} count={0} canEdit={canEdit} compact />,
              label: s.name,
              tasks: groups.get(s.id) ?? [],
              addDefaults: { projectId, sectionId: s.id },
            })),
          ]}
          onDrop={({ task, columnId, before, after }) =>
            actions.place(task, {
              projectId,
              sectionId: columnId === 'none' ? null : columnId,
              parentId: null,
              childOrder: orderBetween(before, after),
            })
          }
          trailing={canEdit && <AddSection projectId={projectId} column />}
          readOnly={!canEdit}
        />
      )}
      {layout === 'calendar' && (
        <CalendarView
          tasks={liveTasks(state).filter((t) => t.projectId === projectId && !t.isCompleted)}
          addDefaults={{ projectId }}
          readOnly={!canEdit}
        />
      )}
      {layout === 'list' && (
        <TaskDnd showCompleted={options.showCompleted}>
          <SortableTaskList
            id="section:none"
            tasks={groups.get(null) ?? []}
            projectId={projectId}
            sectionId={null}
            orderedIds={orderedIds}
            footer={canEdit && <InlineAdd defaults={{ projectId, sectionId: null }} />}
          />
          {sections.map((s) => (
            <SectionBlock
              key={s.id}
              section={s}
              tasks={groups.get(s.id) ?? []}
              orderedIds={orderedIds}
              canEdit={canEdit}
            />
          ))}
        </TaskDnd>
      )}
      {layout === 'list' && canEdit && <AddSection projectId={projectId} />}
      {empty && !canEdit && <EmptyState title="Nothing here yet" />}
      {layout === 'list' && options.showCompleted && <CompletedList projectId={projectId} />}
      <ProjectDialog open={editing} onClose={() => setEditing(false)} project={project} />
    </Page>
  );
}

function ProjectMenu({ project, onEdit }: { project: Project; onEdit: () => void }) {
  const send = useSend();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const canManage = ['owner', 'admin'].includes(project.role);
  return (
    <Popover
      align="right"
      trigger={(p) => (
        <button
          type="button"
          aria-label="Project actions"
          className="rounded-md p-1 text-muted hover:bg-surface-alt"
          {...p}
        >
          <MoreIcon />
        </button>
      )}
    >
      {(close) => (
        <>
          {canManage && (
            <MenuItem
              icon={<EditIcon />}
              onClick={() => {
                close();
                onEdit();
              }}
            >
              Edit project
            </MenuItem>
          )}
          <MenuItem
            icon={<StarIcon filled={project.isFavorite} />}
            onClick={() => {
              close();
              send('project_update', { id: project.id, isFavorite: !project.isFavorite });
            }}
          >
            {project.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
          </MenuItem>
          {canManage && (
            <MenuItem
              icon={<ArchiveIcon />}
              onClick={() => {
                close();
                send(project.isArchived ? 'project_unarchive' : 'project_archive', {
                  id: project.id,
                });
              }}
            >
              {project.isArchived ? 'Unarchive' : 'Archive'}
            </MenuItem>
          )}
          {project.role === 'owner' && (
            <MenuItem
              icon={<TrashIcon />}
              danger
              onClick={() => {
                close();
                void confirm({
                  title: 'Delete project?',
                  message: `“${project.name}”, its sub-projects and all their tasks will be permanently deleted.`,
                  confirmLabel: 'Delete',
                  danger: true,
                }).then((ok) => {
                  if (ok) {
                    send('project_delete', { id: project.id });
                    void navigate({ to: '/inbox' });
                  }
                });
              }}
            >
              Delete project
            </MenuItem>
          )}
        </>
      )}
    </Popover>
  );
}

function SectionBlock({
  section,
  tasks,
  orderedIds,
  canEdit,
}: {
  section: Section;
  tasks: Task[];
  orderedIds: string[];
  canEdit: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="mt-6" aria-label={section.name}>
      <div className="flex items-center gap-1 border-b border-line pb-1">
        <button
          type="button"
          aria-label={collapsed ? 'Expand section' : 'Collapse section'}
          className="text-muted"
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronIcon open={!collapsed} />
        </button>
        <SectionHeading section={section} count={tasks.length} canEdit={canEdit} />
      </div>
      {!collapsed && (
        <SortableTaskList
          id={`section:${section.id}`}
          tasks={tasks}
          projectId={section.projectId}
          sectionId={section.id}
          orderedIds={orderedIds}
          footer={
            canEdit && (
              <InlineAdd defaults={{ projectId: section.projectId, sectionId: section.id }} />
            )
          }
        />
      )}
    </section>
  );
}

/** Section name with rename / archive / delete (list headings and board columns). */
function SectionHeading({
  section,
  count,
  canEdit,
  compact = false,
}: {
  section: Section;
  count: number;
  canEdit: boolean;
  compact?: boolean;
}) {
  const send = useSend();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(section.name);
  return (
    <div className="group flex min-w-0 flex-1 items-center gap-1">
      {renaming ? (
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) send('section_update', { id: section.id, name: name.trim() });
            setRenaming(false);
          }}
        >
          <input
            autoFocus
            className={`${inputClass} py-1`}
            aria-label="Section name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setRenaming(false)}
          />
        </form>
      ) : (
        <span className={`min-w-0 flex-1 truncate font-semibold ${compact ? 'text-sm' : ''}`}>
          {section.name}{' '}
          {!compact && <span className="text-sm font-normal text-muted">{count || ''}</span>}
        </span>
      )}
      {canEdit && (
        <Popover
          align="right"
          trigger={(p) => (
            <button
              type="button"
              aria-label="Section actions"
              className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-alt focus:opacity-100"
              {...p}
            >
              <MoreIcon />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<EditIcon />}
                onClick={() => {
                  close();
                  setName(section.name);
                  setRenaming(true);
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                icon={<ArchiveIcon />}
                onClick={() => {
                  close();
                  send('section_archive', { id: section.id });
                }}
              >
                Archive
              </MenuItem>
              <MenuItem
                icon={<TrashIcon />}
                danger
                onClick={() => {
                  close();
                  void confirm({
                    title: 'Delete section?',
                    message: `“${section.name}” and its ${count} task(s) will be deleted.`,
                    confirmLabel: 'Delete',
                    danger: true,
                  }).then((ok) => ok && send('section_delete', { id: section.id }));
                }}
              >
                Delete
              </MenuItem>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}

function AddSection({ projectId, column = false }: { projectId: string; column?: boolean }) {
  const send = useSend();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) send('section_add', { id: newId(), projectId, name: name.trim() });
    setName('');
    setOpen(false);
  };
  if (!open && column)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-muted hover:text-accent"
      >
        <PlusIcon /> Add section
      </button>
    );
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-6 flex w-full items-center gap-2 text-sm text-muted hover:text-accent"
      >
        <span className="h-px flex-1 bg-line" />
        <PlusIcon /> Add section
        <span className="h-px flex-1 bg-line" />
      </button>
    );
  return (
    <form onSubmit={submit} className={column ? 'flex flex-col gap-2' : 'mt-6 flex gap-2'}>
      <input
        autoFocus
        className={inputClass}
        placeholder="Name this section"
        aria-label="Section name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      />
      <Button type="submit">Add</Button>
      <Button variant="secondary" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

/** Completed tasks come from the server (sync only carries the last week of them). */
function CompletedList({ projectId }: { projectId: string }) {
  const [before, setBefore] = useState<string[]>([]);
  const pages = useQuery({
    queryKey: ['completed', projectId, before],
    queryFn: async () => {
      const all: Task[] = [];
      let cursor: string | null = null;
      for (let i = 0; i <= before.length; i++) {
        const res: { tasks: Task[]; nextBefore: string | null } = await api(
          'GET',
          `/api/v1/tasks/completed?projectId=${projectId}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
        );
        all.push(...res.tasks);
        cursor = res.nextBefore;
        if (!cursor) break;
      }
      return { tasks: all, more: cursor };
    },
  });
  const tasks = (pages.data?.tasks ?? []).filter((t) => !t.parentId);
  return (
    <section className="mt-8" aria-label="Completed tasks">
      <h2 className="mb-1 border-b border-line pb-1 font-semibold text-muted">Completed</h2>
      {tasks.length ? (
        <PlainTaskList tasks={tasks} showProject={false} />
      ) : (
        <p className="py-2 text-sm text-muted">No completed tasks.</p>
      )}
      {pages.data?.more && (
        <Button variant="ghost" onClick={() => setBefore([...before, pages.data.more ?? ''])}>
          Show more
        </Button>
      )}
    </section>
  );
}
