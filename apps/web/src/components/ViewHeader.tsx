import type { ReactNode } from 'react';
import type { ViewOptions } from '../lib/view-options.js';
import type { GroupMode, SortMode } from '../lib/views.js';
import { Popover } from './ui.js';

const SORTS: [SortMode, string][] = [
  ['manual', 'Manual'],
  ['date', 'Date'],
  ['priority', 'Priority'],
  ['name', 'Name'],
];
const GROUPS: [GroupMode, string][] = [
  ['none', 'None'],
  ['project', 'Project'],
  ['date', 'Date'],
  ['priority', 'Priority'],
  ['label', 'Label'],
];

export function ViewHeader({
  title,
  subtitle,
  options,
  setOptions,
  allow = { sort: true, group: true, completed: false },
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  options?: ViewOptions;
  setOptions?: (p: Partial<ViewOptions>) => void;
  allow?: { sort?: boolean; group?: boolean; completed?: boolean };
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 className="text-xl font-bold">{title}</h1>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-1">
        {actions}
        {options && setOptions && (
          <Popover
            align="right"
            trigger={(p) => (
              <button
                type="button"
                {...p}
                className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-alt"
              >
                View
              </button>
            )}
            panelClassName="w-56 p-3"
          >
            <div className="space-y-3">
              {allow.sort && (
                <Choice
                  label="Sort by"
                  value={options.sort}
                  choices={SORTS}
                  onChange={(sort) => setOptions({ sort })}
                />
              )}
              {allow.group && (
                <Choice
                  label="Group by"
                  value={options.group}
                  choices={GROUPS}
                  onChange={(group) => setOptions({ group })}
                />
              )}
              {allow.completed && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={options.showCompleted}
                    onChange={(e) => setOptions({ showCompleted: e.target.checked })}
                  />
                  Show completed tasks
                </label>
              )}
            </div>
          </Popover>
        )}
      </div>
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <select
        className="w-full rounded-md border border-line bg-bg px-2 py-1"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {choices.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-3xl px-4 py-6 pb-28 sm:px-10">{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 text-sm text-muted">{children}</p>}
    </div>
  );
}
