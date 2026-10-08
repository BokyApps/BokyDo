import type { Filter, Workspace } from '@bokydo/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { todayIn } from '../lib/dates.js';
import { useFilter } from '../lib/filters.js';
import { useSyncState, useTimeZone } from '../lib/sync.js';
import { useTaskUI } from '../lib/task-ui.js';
import { isOpen, liveTasks, projectTree, todayTasks, type ProjectNode } from '../lib/views.js';
import {
  ArchiveIcon,
  CheckIcon,
  ChevronIcon,
  TemplateIcon,
  InboxIcon,
  MicIcon,
  PlusIcon,
  SearchIcon,
  TagIcon,
  TodayIcon,
  UpcomingIcon,
} from './icons.js';
import { ProjectDot } from './pickers.js';
import { ProjectDialog } from './ProjectDialog.js';
import {
  atLeast,
  FolderMenu,
  NameDialog,
  NewWorkspaceDialog,
  WorkspaceDialog,
} from './Workspaces.js';
import { newId, useSend } from '../lib/sync.js';

const item = 'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg hover:bg-surface-alt';
const active = { className: 'bg-accent/10 font-medium text-fg hover:bg-accent/15' };

export function Sidebar({
  onSearch,
  onRamble,
  onNavigate,
}: {
  onSearch: () => void;
  /** Shown only when the server offers Ramble to this user. */
  onRamble?: (() => void) | undefined;
  onNavigate?: () => void;
}) {
  const state = useSyncState();
  const ui = useTaskUI();
  const today = todayIn(useTimeZone());
  const [addingProject, setAddingProject] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const open = liveTasks(state).filter(isOpen);
  const count = (projectId: string) => open.filter((t) => t.projectId === projectId).length;
  const t = todayTasks(state, today);
  const inboxId = state.user?.inboxProjectId;
  const all = projectTree(state);
  const teamIds = new Set(state.workspaces.map((w) => w.id));
  // Personal projects, plus team projects shared with you directly from a team you're not in.
  const tree = all.filter((n) => !n.project.workspaceId || !teamIds.has(n.project.workspaceId));
  const [addingTeam, setAddingTeam] = useState(false);
  const favorites = [...state.projects.values()].filter(
    (p) => p.isFavorite && !p.isArchived && !p.isInbox,
  );
  const favoriteLabels = [...state.labels.values()].filter((l) => l.isFavorite);
  const favoriteFilters = [...state.filters.values()].filter((f) => f.isFavorite);

  return (
    <nav
      aria-label="Main"
      className="flex h-full flex-col gap-4 overflow-y-auto p-3"
      onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}
    >
      <div className="space-y-0.5">
        <button
          type="button"
          className={`${item} w-full font-medium text-accent`}
          onClick={() => ui.openQuickAdd()}
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
            <PlusIcon />
          </span>{' '}
          Add task
        </button>
        {onRamble && (
          <button type="button" className={`${item} w-full`} onClick={onRamble}>
            <MicIcon /> Ramble
          </button>
        )}
        <button type="button" className={`${item} w-full`} onClick={onSearch}>
          <SearchIcon /> Search
        </button>
        <Link to="/inbox" className={item} activeProps={active}>
          <span className="text-p3">
            <InboxIcon />
          </span>{' '}
          Inbox <Count n={inboxId ? count(inboxId) : 0} />
        </Link>
        <Link to="/today" className={item} activeProps={active}>
          <span className="text-success">
            <TodayIcon />
          </span>{' '}
          Today <Count n={t.today.length + t.overdue.length} danger={t.overdue.length > 0} />
        </Link>
        <Link to="/upcoming" className={item} activeProps={active}>
          <span className="text-p2">
            <UpcomingIcon />
          </span>{' '}
          Upcoming
        </Link>
        <Link to="/completed" className={item} activeProps={active}>
          <span className="text-muted">
            <CheckIcon />
          </span>{' '}
          Completed
        </Link>
        <Link to="/productivity" className={item} activeProps={active}>
          <span className="text-muted">▤</span> Productivity
        </Link>
        {state.invitations.length > 0 && (
          <Link to="/invitations" className={item} activeProps={active}>
            <span className="text-accent">✉</span> Invitations{' '}
            <Count n={state.invitations.length} danger />
          </Link>
        )}
        <Link to="/filters-labels" className={item} activeProps={active}>
          <span className="text-p1">
            <TagIcon />
          </span>{' '}
          Filters &amp; Labels
        </Link>
        <Link to="/templates" className={item} activeProps={active}>
          <span className="text-muted">
            <TemplateIcon />
          </span>{' '}
          Templates
        </Link>
      </div>

      {(favorites.length > 0 || favoriteLabels.length > 0 || favoriteFilters.length > 0) && (
        <div className="space-y-0.5">
          <h2 className="px-2 text-xs font-semibold text-muted">Favourites</h2>
          {favorites.map((p) => (
            <Link
              key={p.id}
              to="/project/$projectId"
              params={{ projectId: p.id }}
              className={item}
              activeProps={active}
            >
              <ProjectDot color={p.color} /> <span className="truncate">{p.name}</span>{' '}
              <Count n={count(p.id)} />
            </Link>
          ))}
          {favoriteLabels.map((l) => (
            <Link
              key={l.id}
              to="/label/$name"
              params={{ name: l.name }}
              className={item}
              activeProps={active}
            >
              <span style={{ color: `var(--bk-project-${l.color.replace(/_/g, '-')})` }}>
                <TagIcon />
              </span>{' '}
              {l.name}
            </Link>
          ))}
          {favoriteFilters.map((f) => (
            <FavoriteFilter key={f.id} filter={f} className={item} />
          ))}
        </div>
      )}

      <div className="space-y-0.5">
        <div className="flex items-center justify-between px-2">
          <button
            type="button"
            className="flex items-center gap-1 text-xs font-semibold text-muted"
            aria-expanded={projectsOpen}
            onClick={() => setProjectsOpen(!projectsOpen)}
          >
            My projects <ChevronIcon open={projectsOpen} />
          </button>
          <button
            type="button"
            aria-label="Add project"
            className="rounded p-0.5 text-muted hover:bg-surface-alt hover:text-fg"
            onClick={() => setAddingProject(true)}
          >
            <PlusIcon />
          </button>
        </div>
        {projectsOpen && <ProjectNodes nodes={tree} count={count} />}
        {projectsOpen && tree.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted">No projects yet.</p>
        )}
        {[...state.projects.values()].some((p) => p.isArchived) && (
          <Link to="/archived" className={`${item} text-muted`} activeProps={active}>
            <ArchiveIcon /> Archived projects
          </Link>
        )}
      </div>
      {state.workspaces.map((w) => (
        <WorkspaceSection
          key={w.id}
          workspace={w}
          nodes={all.filter((n) => n.project.workspaceId === w.id)}
          count={count}
        />
      ))}
      <button
        type="button"
        className={`${item} w-full text-muted`}
        onClick={() => setAddingTeam(true)}
      >
        <PlusIcon /> Add team
      </button>
      <ProjectDialog open={addingProject} onClose={() => setAddingProject(false)} />
      <NewWorkspaceDialog open={addingTeam} onClose={() => setAddingTeam(false)} />
    </nav>
  );
}

function WorkspaceSection({
  workspace,
  nodes,
  count,
}: {
  workspace: Workspace;
  nodes: ProjectNode[];
  count: (id: string) => number;
}) {
  const state = useSyncState();
  const send = useSend();
  const [open, setOpen] = useState(true);
  const [settings, setSettings] = useState(false);
  const [adding, setAdding] = useState<{ folderId: string | null } | null>(null);
  const [addingFolder, setAddingFolder] = useState(false);
  const folders = state.folders
    .filter((f) => f.workspaceId === workspace.id)
    .sort((a, b) => (a.childOrder < b.childOrder ? -1 : a.childOrder > b.childOrder ? 1 : 0));
  const folderIds = new Set(folders.map((f) => f.id));
  const unfiled = nodes.filter((n) => !n.project.folderId || !folderIds.has(n.project.folderId));
  const admin = atLeast(workspace, 'admin');
  const iconButton = 'rounded p-0.5 text-muted hover:bg-surface-alt hover:text-fg';
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-1 px-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 text-xs font-semibold text-muted"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="truncate">{workspace.name}</span> <ChevronIcon open={open} />
        </button>
        <span className="flex shrink-0 items-center">
          {admin && (
            <button
              type="button"
              aria-label={`Add folder to ${workspace.name}`}
              title="Add folder"
              className={`${iconButton} text-xs`}
              onClick={() => setAddingFolder(true)}
            >
              ▤
            </button>
          )}
          <button
            type="button"
            aria-label={`Settings for ${workspace.name}`}
            title="Team settings"
            className={`${iconButton} text-xs`}
            onClick={() => setSettings(true)}
          >
            ⚙
          </button>
          {atLeast(workspace, 'member') && (
            <button
              type="button"
              aria-label={`Add project to ${workspace.name}`}
              className={iconButton}
              onClick={() => setAdding({ folderId: null })}
            >
              <PlusIcon />
            </button>
          )}
        </span>
      </div>
      {open && (
        <>
          {folders.map((f) => {
            const inFolder = nodes.filter((n) => n.project.folderId === f.id);
            return (
              <FolderGroup key={f.id} name={f.name} empty={inFolder.length === 0}>
                {admin && <FolderMenu folder={f} />}
                <ProjectNodes nodes={inFolder} count={count} depth={1} />
              </FolderGroup>
            );
          })}
          <ProjectNodes nodes={unfiled} count={count} />
          {nodes.length === 0 && folders.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted">No team projects yet.</p>
          )}
        </>
      )}
      <WorkspaceDialog workspace={workspace} open={settings} onClose={() => setSettings(false)} />
      <ProjectDialog
        open={adding !== null}
        onClose={() => setAdding(null)}
        workspaceId={workspace.id}
        folderId={adding?.folderId ?? null}
      />
      <NameDialog
        open={addingFolder}
        title={`Add folder to ${workspace.name}`}
        label="Folder name"
        submitLabel="Add"
        onClose={() => setAddingFolder(false)}
        onSubmit={(name) => send('folder_add', { id: newId(), workspaceId: workspace.id, name })}
      />
    </div>
  );
}

function FolderGroup({
  name,
  empty,
  children,
}: {
  name: string;
  empty: boolean;
  children: [React.ReactNode, React.ReactNode];
}) {
  const [open, setOpen] = useState(true);
  const [menu, list] = children;
  return (
    <div>
      <div className="group flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-alt">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronIcon open={open} /> <span className="truncate">{name}</span>
        </button>
        {menu}
      </div>
      {open && list}
      {open && empty && <p className="py-0.5 pl-8 text-xs text-muted">Empty folder</p>}
    </div>
  );
}

function ProjectNodes({
  nodes,
  count,
  depth = 0,
}: {
  nodes: ProjectNode[];
  count: (id: string) => number;
  depth?: number;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return (
    <>
      {nodes.map(({ project: p, children }) => (
        <div key={p.id}>
          <div className="relative">
            {children.length > 0 && (
              <button
                type="button"
                aria-label={collapsed.has(p.id) ? `Expand ${p.name}` : `Collapse ${p.name}`}
                className="absolute top-1.5 text-muted"
                style={{ left: `${depth * 0.9 - 0.2}rem` }}
                onClick={() =>
                  setCollapsed((s) =>
                    s.has(p.id) ? new Set([...s].filter((x) => x !== p.id)) : new Set([...s, p.id]),
                  )
                }
              >
                <ChevronIcon open={!collapsed.has(p.id)} />
              </button>
            )}
            <Link
              to="/project/$projectId"
              params={{ projectId: p.id }}
              className={item}
              activeProps={active}
              style={{ paddingLeft: `${0.5 + depth * 0.9 + 0.6}rem` }}
            >
              <ProjectDot color={p.color} /> <span className="truncate">{p.name}</span>
              {p.role !== 'owner' && (
                <span className="text-xs text-muted" title="Shared with you">
                  ⇄
                </span>
              )}
              <Count n={count(p.id)} />
            </Link>
          </div>
          {children.length > 0 && !collapsed.has(p.id) && (
            <ProjectNodes nodes={children} count={count} depth={depth + 1} />
          )}
        </div>
      ))}
    </>
  );
}

function Count({ n, danger = false }: { n: number; danger?: boolean }) {
  if (!n) return null;
  return <span className={`ml-auto text-xs ${danger ? 'text-danger' : 'text-muted'}`}>{n}</span>;
}

function FavoriteFilter({ filter, className }: { filter: Filter; className: string }) {
  const result = useFilter(filter.query);
  const n = result.ok ? new Set(result.lists.flatMap((l) => l.tasks.map((t) => t.id))).size : 0;
  return (
    <Link
      to="/filter/$filterId"
      params={{ filterId: filter.id }}
      className={className}
      activeProps={active}
    >
      <span style={{ color: `var(--bk-project-${filter.color.replace(/_/g, '-')})` }} aria-hidden>
        ⚲
      </span>{' '}
      <span className="truncate">{filter.name}</span> <Count n={n} />
    </Link>
  );
}
