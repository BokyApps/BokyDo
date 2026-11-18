import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { RevealAnchor } from './callbacks.js';

export interface RevealState {
  plaintext: string;
  anchor: RevealAnchor;
}

/**
 * Review fix (Reveal lifecycle): the plaintext is rendered in a portal to document.body — OUTSIDE
 * the editor root — so it is never part of the ProseMirror DOM, selection, copy, or the document
 * state. It is non-selectable and blocks copy/cut/drag, with `aria-live="polite"` (not a
 * `role="status"` inside the editor). The page owns its whole lifecycle via `RevealController`;
 * this component is purely presentational plus the Escape/blur close signals.
 */
export function RevealOverlay({
  plaintext,
  anchor,
  onClose,
}: RevealState & { onClose: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const style = {
    position: 'fixed' as const,
    left: Math.max(0, anchor.left),
    top: anchor.bottom + 4,
  };

  return createPortal(
    <div
      ref={ref}
      className="bk-reveal-overlay select-none"
      contentEditable={false}
      aria-live="polite"
      tabIndex={-1}
      style={style}
      onBlur={onClose}
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
      data-testid="reveal-overlay"
    >
      <span className="bk-reveal-text">{plaintext}</span>
      <button type="button" contentEditable={false} onClick={onClose} className="bk-reveal-close">
        {t('notes.editor.censorClose', { defaultValue: 'Close' })}
      </button>
    </div>,
    document.body,
  );
}
