import { COLORS, type Color, type Project } from '@bokydo/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { newId, useSend, useSyncState } from '../lib/sync.js';
import { flattenTree, projectTree } from '../lib/views.js';
import { ProjectDot } from './pickers.js';
import { Button, Checkbox, Dialog, SelectField, TextField } from './ui.js';

const label = (c: string) => c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());

/** Create or edit a project: name, colour, parent, favourite. */
export function ProjectDialog({
  open,
  onClose,
  project,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={project ? 'Edit project' : 'Add project'}>
      <ProjectForm onClose={onClose} {...(project ? { project } : {})} />
    </Dialog>
  );
}

function ProjectForm({ onClose, project }: { onClose: () => void; project?: Project }) {
  const state = useSyncState();
  const send = useSend();
  const navigate = useNavigate();
  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState<Color>(project?.color ?? 'charcoal');
  const [parentId, setParentId] = useState(project?.parentId ?? '');
  const [favorite, setFavorite] = useState(project?.isFavorite ?? false);
  // A project can't move under itself or its descendants; parents must be your own.
  const parents = flattenTree(projectTree(state)).filter(
    ({ project: p, depth }) =>
      p.id !== project?.id &&
      depth < 2 &&
      p.role === 'owner' &&
      !isDescendant(state.projects, p, project?.id),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (project) {
      send('project_update', { id: project.id, name: name.trim(), color, isFavorite: favorite });
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
      });
      void navigate({ to: '/project/$projectId', params: { projectId: id } });
    }
    onClose();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <TextField
        label="Name"
        required
        maxLength={120}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Colour</legend>
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
      <SelectField
        label="Parent project"
        value={parentId}
        onChange={(e) => setParentId(e.target.value)}
        options={[
          { value: '', label: 'No parent' },
          ...parents.map(({ project: p, depth }) => ({
            value: p.id,
            label: `${'— '.repeat(depth)}${p.name}`,
          })),
        ]}
      />
      <Checkbox
        label="Add to favourites"
        checked={favorite}
        onChange={(e) => setFavorite(e.target.checked)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">{project ? 'Save' : 'Add'}</Button>
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
