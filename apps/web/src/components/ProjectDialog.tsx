import { COLORS, type Color, type Project, type ProjectVisibility } from '@bokydo/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { newId, useSend, useSyncState } from '../lib/sync.js';
import { flattenTree, projectTree } from '../lib/views.js';
import { ProjectDot } from './pickers.js';
import { Button, Checkbox, Dialog, SelectField, TextField } from './ui.js';
import { atLeast } from './Workspaces.js';

const label = (c: string) => c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

/** Create or edit a project: name, colour, team, folder, visibility, parent, favourite. */
export function ProjectDialog({
  open,
  onClose,
  project,
  workspaceId = null,
  folderId = null,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project;
  /** Defaults for a new project. */
  workspaceId?: string | null;
  folderId?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose} title={project ? t('project.edit') : t('project.add')}>
      {open && (
        <ProjectForm
          onClose={onClose}
          workspaceId={workspaceId}
          folderId={folderId}
          {...(project ? { project } : {})}
        />
      )}
    </Dialog>
  );
}

function ProjectForm({
  onClose,
  project,
  workspaceId: defaultWorkspace,
  folderId: defaultFolder,
}: {
  onClose: () => void;
  project?: Project;
  workspaceId: string | null;
  folderId: string | null;
}) {
  const { t } = useTranslation();
  const state = useSyncState();
  const send = useSend();
  const navigate = useNavigate();
  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState<Color>(project?.color ?? 'charcoal');
  const [parentId, setParentId] = useState(project?.parentId ?? '');
  const [favorite, setFavorite] = useState(project?.isFavorite ?? false);
  const [workspaceId, setWorkspaceId] = useState(project?.workspaceId ?? defaultWorkspace ?? '');
  const [folderId, setFolderId] = useState(project?.folderId ?? defaultFolder ?? '');
  const [visibility, setVisibility] = useState<ProjectVisibility>(
    project?.visibility ?? 'workspace',
  );
  // Teams you can put projects in; a sub-project always lives in its parent's team, so only
  // top-level projects move between teams (by their owner).
  const teams = state.workspaces.filter((w) => atLeast(w, 'member'));
  const canMoveTeam =
    !project || (project.role === 'owner' && !project.parentId && !project.isInbox);
  const canManage = !project || project.role === 'owner' || project.role === 'admin';
  const visibilityLabel = (v: ProjectVisibility) =>
    v === 'workspace' ? t('project.visibilityWorkspace') : t('project.visibilityRestricted');
  const folders = state.folders.filter((f) => f.workspaceId === workspaceId);
  // A project can't move under itself or its descendants; parents must be your own and in
  // the same team.
  const parents = flattenTree(projectTree(state)).filter(
    ({ project: p, depth }) =>
      p.id !== project?.id &&
      depth < 2 &&
      p.role === 'owner' &&
      (p.workspaceId ?? '') === workspaceId &&
      !isDescendant(state.projects, p, project?.id),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (project) {
      const movedTeam = canMoveTeam && (project.workspaceId ?? '') !== workspaceId;
      if (movedTeam)
        send('project_move_workspace', { id: project.id, workspaceId: workspaceId || null });
      // A move resets folder and visibility; the form's choices apply on top.
      const was = movedTeam
        ? { folderId: null, visibility: 'restricted' }
        : { folderId: project.folderId, visibility: project.visibility };
      const teamFields =
        workspaceId && canManage
          ? {
              ...((folderId || null) !== was.folderId ? { folderId: folderId || null } : {}),
              ...(visibility !== was.visibility ? { visibility } : {}),
            }
          : {};
      send('project_update', {
        id: project.id,
        name: name.trim(),
        color,
        isFavorite: favorite,
        ...teamFields,
      });
      if ((project.parentId ?? '') !== parentId)
        send('project_move', { id: project.id, parentId: parentId || null });
    } else {
      const id = newId();
      send('project_add', {
        id,
        name: name.trim(),
        color,
        parentId: parentId || null,
        isFavorite: favorite,
        workspaceId: workspaceId || null,
        ...(workspaceId ? { folderId: folderId || null, visibility } : {}),
      });
      void navigate({ to: '/project/$projectId', params: { projectId: id } });
    }
    onClose();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <TextField
        label={t('project.name')}
        required
        maxLength={120}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{t('project.colour')}</legend>
        <div className="grid grid-cols-10 gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={label(c)}
              aria-pressed={color === c}
              title={label(c)}
              onClick={() => setColor(c)}
              className={`flex size-7 items-center justify-center rounded-md ${color === c ? 'ring-2 ring-accent' : 'hover:bg-surface-alt'}`}
            >
              <ProjectDot color={c} />
            </button>
          ))}
        </div>
      </fieldset>
      {(teams.length > 0 || project?.workspaceId) && canMoveTeam && (
        <SelectField
          label={t('project.team')}
          value={workspaceId}
          onChange={(e) => {
            setWorkspaceId(e.target.value);
            setFolderId('');
            setParentId('');
          }}
          options={[
            { value: '', label: t('project.personal') },
            ...teams.map((w) => ({ value: w.id, label: w.name })),
            // A team you can't add projects to any more (e.g. now a guest): keep it selectable.
            ...(project?.workspaceId && !teams.some((w) => w.id === project.workspaceId)
              ? [{ value: project.workspaceId, label: t('project.currentTeam') }]
              : []),
          ]}
        />
      )}
      {workspaceId && canManage && (
        <>
          {folders.length > 0 && (
            <SelectField
              label={t('project.folder')}
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              options={[
                { value: '', label: t('project.noFolder') },
                ...folders.map((f) => ({ value: f.id, label: f.name })),
              ]}
            />
          )}
          <SelectField
            label={t('project.visibility')}
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as ProjectVisibility)}
            options={(['workspace', 'restricted'] as const).map((v) => ({
              value: v,
              label: visibilityLabel(v),
            }))}
          />
        </>
      )}
      <SelectField
        label={t('project.parent')}
        value={parentId}
        onChange={(e) => setParentId(e.target.value)}
        options={[
          { value: '', label: t('project.noParent') },
          ...parents.map(({ project: p, depth }) => ({
            value: p.id,
            label: `${'— '.repeat(depth)}${p.name}`,
          })),
        ]}
      />
      <Checkbox
        label={t('project.favourite')}
        checked={favorite}
        onChange={(e) => setFavorite(e.target.checked)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit">{project ? t('common.save') : t('common.add')}</Button>
      </div>
    </form>
  );
}

function isDescendant(
  projects: ReadonlyMap<string, Project>,
  p: Project,
  ancestorId: string | undefined,
): boolean {
  for (let cur: Project | undefined = p; cur?.parentId; cur = projects.get(cur.parentId))
    if (cur.parentId === ancestorId) return true;
  return false;
}
