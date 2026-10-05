import { activeTrigger, type Token, type TokenKind, type Trigger } from '@bokydo/nlp';
import {
  useId,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

/** Highlight colours per token kind (backgrounds only: the text itself is the textarea's). */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  due: 'bg-success/20',
  deadline: 'bg-danger/15',
  priority: 'bg-p1/20',
  label: 'bg-p3/20',
  project: 'bg-accent/20',
  section: 'bg-accent/20',
  assignee: 'bg-warning/20',
  duration: 'bg-warning/20',
  reminder: 'bg-warning/20',
};

export interface Suggestion {
  /** Inserted after the trigger character. */
  value: string;
  label: ReactNode;
}

const MAX_SUGGESTIONS = 8;

/**
 * Task-name field for quick add. A mirror layer behind a transparent textarea paints the parsed
 * tokens ("tomorrow", "#Work", "p1") as they're typed, and `#`, `@`, `/` open autocomplete.
 */
export function SmartInput({
  value,
  onChange,
  tokens,
  suggest,
  onSubmit,
  inputRef,
  placeholder = 'Task name',
}: {
  value: string;
  onChange: (value: string) => void;
  tokens: readonly Token[];
  /** Candidates for the trigger under the caret. */
  suggest: (trigger: Trigger) => Suggestion[];
  onSubmit: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}) {
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const trigger = activeTrigger(value, caret);
  const open = trigger !== null && trigger.start !== dismissed;
  const suggestions = open && trigger ? suggest(trigger).slice(0, MAX_SUGGESTIONS) : [];
  const showList = open && suggestions.length > 0;
  const selected = Math.min(active, suggestions.length - 1);

  // Grow with the content (one line by default).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, inputRef]);

  const pick = (s: Suggestion) => {
    if (!trigger) return;
    const before = value.slice(0, trigger.start + 1) + s.value + ' ';
    const next = before + value.slice(caret).replace(/^\S*/, '').replace(/^ /, '');
    onChange(next);
    setActive(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(before.length, before.length);
      setCaret(before.length);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showList) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggestions.length;
        setActive((selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const s = suggestions[selected];
        if (s) pick(s);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(trigger?.start ?? null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  // Mirror: the same text, transparent, with highlighted token spans.
  const pieces: ReactNode[] = [];
  let at = 0;
  for (const t of tokens) {
    if (t.start < at || t.end > value.length) continue;
    pieces.push(value.slice(at, t.start));
    pieces.push(
      <mark key={t.start} className={`rounded-sm text-transparent ${TOKEN_CLASS[t.kind]}`}>
        {value.slice(t.start, t.end)}
      </mark>,
    );
    at = t.end;
  }
  pieces.push(value.slice(at), '​');

  const textClass = 'm-0 w-full p-0 text-sm font-medium leading-6 break-words whitespace-pre-wrap';
  return (
    <div className="relative">
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 text-transparent ${textClass}`}
      >
        {pieces}
      </div>
      <textarea
        ref={inputRef}
        autoFocus
        rows={1}
        aria-label="Task name"
        placeholder={placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={showList ? `${listId}-${selected}` : undefined}
        spellCheck
        className={`relative block resize-none overflow-hidden bg-transparent text-fg placeholder:text-muted focus:outline-none ${textClass}`}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
          setDismissed(null);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Suggestions"
          className="absolute top-full left-0 z-50 mt-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-line bg-surface p-1 text-sm shadow-lg"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === selected}
              className={`cursor-pointer truncate rounded-md px-2 py-1.5 ${i === selected ? 'bg-surface-alt' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
