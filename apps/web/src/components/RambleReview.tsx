import type { RambleResolvedTask } from '@bokydo/shared';
import {
  issueText,
  projectFor,
  visibleIssues,
  type ProjectChoice,
  type ProjectOverrides,
} from '../lib/ramble.js';
import { Button, SelectField, TextField } from './ui.js';

interface ReviewProps {
  draft: RambleResolvedTask[];
  overrides: ProjectOverrides;
  changes: Map<string, 'added' | 'changed'>;
  projects: ProjectChoice[];
  inboxId: string | null;
  /** The task the server refused to create (the commit is all or nothing). */
  failedRef: string | null;
  onContent: (ref: string, content: string) => void;
  onProject: (ref: string, projectId: string) => void;
  onRemove: (ref: string) => void;
}

/** The draft as the user reviews it before anything is created. */
export function RambleReview(props: ReviewProps) {
  return (
    <ul aria-label="Draft tasks" className="space-y-2">
      {props.draft.map((task, i) => (
        <ReviewRow
          key={task.ref}
          n={i + 1}
          task={task}
          overrides={props.overrides}
          change={props.changes.get(task.ref)}
          failed={props.failedRef === task.ref}
          projects={props.projects}
          inboxId={props.inboxId}
          onContent={props.onContent}
          onProject={props.onProject}
          onRemove={props.onRemove}
        />
      ))}
    </ul>
  );
}

function ReviewRow({
  n,
  task,
  overrides,
  change,
  failed,
  projects,
  inboxId,
  onContent,
  onProject,
  onRemove,
}: {
  n: number;
  task: RambleResolvedTask;
  overrides: ProjectOverrides;
  change: 'added' | 'changed' | undefined;
  failed: boolean;
  projects: ProjectChoice[];
  inboxId: string | null;
  onContent: (ref: string, content: string) => void;
  onProject: (ref: string, projectId: string) => void;
  onRemove: (ref: string) => void;
}) {
  const hasPick = overrides[task.ref] !== undefined;
  const issues = visibleIssues(task.resolved.issues, hasPick);
  const details: string[] = [];
  if (task.due) details.push(`Due ${task.due}`);
  if (task.priority !== undefined) details.push(`Priority ${task.priority}`);
  if (task.labels?.length) details.push(`Labels ${task.labels.join(', ')}`);
  if (task.assignee) details.push(`Assigned to ${task.assignee}`);
  if (task.section) details.push(`Section ${task.section}`);
  const badge = failed
    ? 'Not created'
    : change === 'added'
      ? 'Added'
      : change === 'changed'
        ? 'Changed'
        : null;
  const border = failed ? 'border-danger' : change ? 'border-accent bg-accent/5' : 'border-line';
  return (
    <li className={`rounded-lg border p-3 ${border}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          {badge && (
            <span className="inline-block rounded bg-accent/10 px-1.5 py-0.5 text-xs font-medium text-fg">
              {badge}
            </span>
          )}
          <TextField
            label={`Task ${n} name`}
            hideLabel
            maxLength={500}
            value={task.content}
            onChange={(e) => onContent(task.ref, e.target.value)}
          />
          {details.length > 0 && <p className="text-xs text-muted">{details.join(' · ')}</p>}
          <SelectField
            label={`Project for task ${n}`}
            value={projectFor(task, overrides) ?? inboxId ?? ''}
            onChange={(e) => onProject(task.ref, e.target.value)}
            options={projects.map((p) => ({ value: p.id, label: p.label }))}
          />
          {issues.length > 0 && (
            <ul className="space-y-0.5 text-xs text-fg">
              {issues.map((issue) => (
                <li key={issue}>{issueText(issue)}</li>
              ))}
            </ul>
          )}
        </div>
        <Button
          variant="ghost"
          className="text-danger"
          aria-label={`Remove task ${n}`}
          onClick={() => onRemove(task.ref)}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}
