import { describeZone, detectTimeZone, searchTimeZones, type ZoneOption } from '@bokydo/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { inputClass } from './ui.js';

const describe = (z: ZoneOption) => [z.city, z.country].filter(Boolean).join(', ');

/**
 * Searchable time-zone combobox: city, country, abbreviation (SAST, ICT), offset (+7, GMT+07:00)
 * or IANA name. Offers the device's zone first. Stores canonical IANA names.
 */
export function TimeZonePicker({
  value,
  onChange,
  label = 'Time zone',
}: {
  value: string | null;
  onChange: (zone: string) => void;
  label?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const detected = useMemo(() => detectTimeZone(), []);
  const current = value ? describeZone(value) : null;
  const results = useMemo(() => (open ? searchTimeZones(query, { limit: 30 }) : []), [query, open]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (zone: string) => {
    onChange(zone);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${id}-opt-${active}` : undefined}
          className={inputClass}
          placeholder={
            current
              ? `${describe(current)} (${current.offsetLabel})`
              : 'Search a city, country, or offset like +7'
          }
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && results[active]) {
              e.preventDefault();
              choose(results[active].id);
            } else if (e.key === 'Escape') setOpen(false);
          }}
        />
        {open && results.length > 0 && (
          <ul
            id={`${id}-list`}
            ref={listRef}
            role="listbox"
            className="absolute z-40 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-line bg-surface p-1 text-sm shadow-lg"
          >
            {results.map((z, i) => (
              <li
                key={z.id}
                id={`${id}-opt-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-3 py-1.5 ${i === active ? 'bg-surface-alt' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(z.id);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span>
                  {describe(z)} <span className="text-xs text-muted">{z.id}</span>
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {z.offsetLabel} · {z.localTime}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted">
        {current ? (
          <>
            Current: {describe(current)}, {current.offsetLabel}, {current.localTime} now.{' '}
          </>
        ) : null}
        {detected && detected !== value && (
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => choose(detected)}
          >
            Use detected: {describe(describeZone(detected))} ({describeZone(detected).offsetLabel})
          </button>
        )}
      </p>
    </div>
  );
}
