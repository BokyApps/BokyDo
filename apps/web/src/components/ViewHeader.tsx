import type { ReactNode } from 'react';
import type { Layout, ViewOptions } from '../lib/view-options.js';
import type { GroupMode, SortMode } from '../lib/views.js';
import { Popover } from './ui.js';

const SORTS: [SortMode, string][] = [
  ['manual', 'Manual'],
  ['date', 'Date'],
  ['priority', 'Priority'],
  ['name', 'Name'],
];
const LAYOUTS: [Layout, string][] = [
  ['list', 'List'],
  ['board', 'Board'],
  ['calendar', 'Calendar'],
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
  layout,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  options?: ViewOptions;
  setOptions?: (p: Partial<ViewOptions>) => void;
  allow?: { sort?: boolean; group?: boolean; completed?: boolean };
  /** Offer list / board / calendar. */
  layout?: { value: Layout; onChange: (layout: Layout) => void };
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
              {layout && (
                <div role="group" aria-label="Layout" className="grid grid-cols-3 gap-1">
                  {LAYOUTS.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={layout.value === value}
                      onClick={() => layout.onChange(value)}
                      className={`rounded-md border px-1 py-1.5 text-xs ${layout.value === value ? 'border-accent bg-accent/10 font-medium text-accent' : 'border-line text-muted hover:bg-surface-alt'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
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

export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={`mx-auto w-full px-4 py-6 pb-28 ${wide ? 'max-w-7xl sm:px-6' : 'max-w-3xl sm:px-10'}`}
    >
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 text-sm text-muted">{children}</p>}
    </div>
  );
}
