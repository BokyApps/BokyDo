import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

/** What the board hands a card so its title bar can be dragged to move the card. */
export interface CardDragHandle {
  setRef: (element: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners | undefined;
}

export const CardDragContext = createContext<CardDragHandle | null>(null);

/**
 * A card's title bar: drag it to move the card, double-click it (or press F2) to rename the note.
 * `onRename` is absent while the note cannot be edited (still loading, read-only, gone), and then
 * the title is only shown. `actions` are the buttons at its right end.
 */
export function NoteCardTitlebar({
  title,
  onRename,
  startRenaming = false,
  actions,
}: {
  title: string;
  onRename?: ((title: string) => void) | undefined;
  /** A new note opens with its title ready to type. */
  startRenaming?: boolean;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const drag = useContext(CardDragContext);
  const [renaming, setRenaming] = useState(startRenaming && Boolean(onRename));
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Set once Enter, Escape or blur ends a rename, so the blur that follows does not save again. */
  const ended = useRef(false);

  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  const startRename = () => {
    if (!onRename) return;
    setValue(title);
    ended.current = false;
    setRenaming(true);
  };
  const finish = (save: boolean) => {
    if (ended.current) return;
    ended.current = true;
    setRenaming(false);
    if (save && value !== title) onRename?.(value);
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'F2') {
      event.preventDefault();
      startRename();
      return;
    }
    drag?.listeners?.onKeyDown?.(event);
  };

  const shown = title || t('notes.untitled', { defaultValue: 'Untitled' });
  return (
    <div className="bk-note-card-titlebar">
      {renaming ? (
        <input
          ref={inputRef}
          type="text"
          className="min-w-0 flex-1 bg-transparent py-1 font-semibold text-fg outline-none placeholder:text-muted"
          aria-label={t('notes.titleLabel', { defaultValue: 'Note title' })}
          placeholder={t('notes.untitled', { defaultValue: 'Untitled' })}
          maxLength={200}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              finish(false);
            }
          }}
        />
      ) : (
        <div
          ref={drag?.setRef}
          tabIndex={0}
          {...drag?.attributes}
          {...drag?.listeners}
          onKeyDown={onHandleKeyDown}
          onDoubleClick={startRename}
          className="bk-note-card-handle"
          aria-label={shown}
          title={
            onRename
              ? t('notes.cardHandleHint', {
                  defaultValue: 'Drag to move. Double-click to rename.',
                })
              : t('notes.cardHandleMoveHint', { defaultValue: 'Drag to move.' })
          }
        >
          <h3 className={`truncate font-semibold ${title ? '' : 'text-muted'}`}>{shown}</h3>
        </div>
      )}
      {actions}
    </div>
  );
}
