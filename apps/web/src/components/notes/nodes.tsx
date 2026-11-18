import { Mark, mergeAttributes, Node, type NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { applyUncensored, clearRemovalMark, markCensoredForRemoval } from './censor-command.js';
import { type RevealAnchor, getCallbacks } from './callbacks.js';
import {
  authorisedEmbed,
  browserSupportsCredentialless,
  createEmbedIframe,
  parseEmbedUrl,
} from './embed.js';
import {
  CENSORED_PLACEHOLDER,
  classifyHref,
  isValidCensorToken,
  isValidEmbedUrl,
  isValidInternalChip,
  isValidNoteFileId,
  NOTE_FILE_SRC_RE,
  NOTE_FILE_PREFIX,
} from './markdown.js';

function domString(value: unknown): string {
  return value == null ? '' : String(value);
}

// ---------------------------------------------------------------------------------------------
// Link mark (safeHref only). Unsafe hrefs are dropped on parse AND on paste by returning false.
// Link titles are preserved (review: link titles must not be lost).
// ---------------------------------------------------------------------------------------------

export const SafeLink = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes() {
    return { href: { default: '' }, title: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: 'a[href]',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const href = el.getAttribute('href') ?? '';
          const cls = classifyHref(href);
          if (cls.kind !== 'link') return false;
          const title = el.getAttribute('title');
          return { href: cls.href, ...(title ? { title } : {}) };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
        class: 'bk-note-link',
      }),
      0,
    ];
  },
});

// ---------------------------------------------------------------------------------------------
// Note-file image: only /api/v1/note-files/<uuid>(\?inline=1)? is ever rendered as an <img>.
// ---------------------------------------------------------------------------------------------

export const NoteImage = Node.create({
  name: 'noteImage',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { id: { default: '' }, alt: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'img[data-note-image]',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const src = el.getAttribute('src') ?? '';
          const match = NOTE_FILE_SRC_RE.exec(src);
          const id = match?.[1];
          if (!id) return false;
          const dataId = el.getAttribute('data-id');
          // If a data-id is present it must agree with the (only trusted) src.
          if (dataId && dataId !== id) return false;
          return { id, alt: el.getAttribute('alt') ?? '' };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const id = isValidNoteFileId(node.attrs.id) ? node.attrs.id : '';
    if (!id) return ['span', { class: 'bk-note-image-missing' }, CENSORED_PLACEHOLDER];
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        'data-note-image': '1',
        'data-id': id,
        src: `${NOTE_FILE_PREFIX}${id}?inline=1`,
        alt: domString(node.attrs.alt),
        class: 'bk-note-image',
      }),
    ];
  },
});

// ---------------------------------------------------------------------------------------------
// File chip: always a download, never rendered inline.
// ---------------------------------------------------------------------------------------------

export const FileChip = Node.create({
  name: 'fileChip',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { id: { default: '' }, name: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'a[data-file-chip]',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const id = el.getAttribute('data-id') ?? '';
          if (!isValidNoteFileId(id)) return false;
          return { id, name: el.textContent ?? '' };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const name = domString(node.attrs.name) || 'file';
    const id = isValidNoteFileId(node.attrs.id) ? node.attrs.id : '';
    if (!id) return ['span', { class: 'bk-file-chip' }, name];
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-file-chip': '1',
        'data-id': id,
        href: `${NOTE_FILE_PREFIX}${id}`,
        download: name,
        rel: 'noopener noreferrer',
        class: 'bk-file-chip',
      }),
      name,
    ];
  },
});

// ---------------------------------------------------------------------------------------------
// Internal chip: bokydo:note|task/<uuid> — a button, never an href (no navigation).
// ---------------------------------------------------------------------------------------------

function InternalChipView({ node, editor }: NodeViewProps) {
  const { t } = useTranslation();
  const kind = node.attrs.kind === 'task' ? 'task' : 'note';
  const label = domString(node.attrs.label) || domString(node.attrs.id);
  return (
    <NodeViewWrapper as="span" className="bk-internal-chip">
      <button
        type="button"
        contentEditable={false}
        className="bk-chip-button"
        title={t('notes.editor.openInternal', { defaultValue: 'Open link in BokyDo' })}
        onClick={() => getCallbacks(editor).onOpenInternal?.(kind, domString(node.attrs.id))}
      >
        <span aria-hidden="true">{kind === 'note' ? '▤' : '☑'}</span> {label}
      </button>
    </NodeViewWrapper>
  );
}

export const InternalChip = Node.create({
  name: 'internalChip',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { kind: { default: 'note' }, id: { default: '' }, label: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-internal-chip]',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const kind = el.getAttribute('data-kind') === 'task' ? 'task' : 'note';
          const id = el.getAttribute('data-id') ?? '';
          if (!isValidInternalChip(kind, id)) return false;
          return { kind, id, label: el.getAttribute('data-label') ?? '' };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const kind = node.attrs.kind === 'task' ? 'task' : 'note';
    const id = isValidNoteFileId(node.attrs.id) ? node.attrs.id : '';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-internal-chip': '1',
        'data-kind': kind,
        'data-id': id,
        'data-label': domString(node.attrs.label),
        class: 'bk-internal-chip',
      }),
      domString(node.attrs.label),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(InternalChipView);
  },
});

// ---------------------------------------------------------------------------------------------
// Censored span: inline atom. Its DOM is only ever the █████ block — cleartext never enters the
// editor document or DOM. Reveal is fire-and-forget: the page shows the plaintext in a portal
// overlay outside the editor root (CONTRACT CHANGE), and owns its whole lifecycle.
// ---------------------------------------------------------------------------------------------

function anchorFrom(el: HTMLElement | null): RevealAnchor {
  const r = el?.getBoundingClientRect();
  return {
    top: r?.top ?? 0,
    left: r?.left ?? 0,
    bottom: r?.bottom ?? 0,
    right: r?.right ?? 0,
  };
}

export function CensoredView({ node, editor, getPos }: NodeViewProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const token = domString(node.attrs.token);

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // A menu is a keyboard surface: opening it moves focus to the first item. Escape closes it and
  // returns focus to the trigger; both are part of E7's "native button semantics".
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [menuOpen]);

  const reveal = useCallback(() => {
    closeMenu(true);
    const cb = getCallbacks(editor);
    // Never receive plaintext here. The page unlocks and renders the overlay in a portal.
    cb.onReveal?.(token, anchorFrom(triggerRef.current));
  }, [closeMenu, editor, token]);

  const removeCensor = useCallback(async () => {
    closeMenu(true);
    const cb = getCallbacks(editor);
    if (!cb.onUncensor || !editor.isEditable) return;
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos == null) return;
    // Bind Remove to THIS atom with a transient id before the async prompt: if the atom is
    // deleted meanwhile, the late result aborts instead of applying to an identical token
    // elsewhere (review: never redirect to a duplicate token).
    const removeId = markCensoredForRemoval(editor, pos);
    if (!removeId) return;
    // The page asks for confirmation before unlocking; keep that contract. History is kept, so
    // undo restores the token.
    const plaintext = await cb.onUncensor(token);
    if (plaintext == null) {
      clearRemovalMark(editor, removeId);
      return;
    }
    if (!applyUncensored(editor, removeId, plaintext)) clearRemovalMark(editor, removeId);
  }, [closeMenu, editor, getPos, token]);

  return (
    <NodeViewWrapper
      as="span"
      className="bk-censored-wrap"
      onKeyDown={(event: ReactKeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('notes.editor.censoredAriaLabel', {
          defaultValue: 'Censored text, options',
        })}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="bk-censored-block"
        contentEditable={false}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {CENSORED_PLACEHOLDER}
      </button>
      {menuOpen && (
        <span ref={menuRef} className="bk-censor-menu" role="menu" contentEditable={false}>
          <button type="button" role="menuitem" onClick={reveal}>
            {t('notes.editor.censorReveal', { defaultValue: 'Reveal' })}
          </button>
          <button type="button" role="menuitem" onClick={() => void removeCensor()}>
            {t('notes.editor.censorRemove', { defaultValue: 'Remove censor' })}
          </button>
        </span>
      )}
    </NodeViewWrapper>
  );
}

export const Censored = Node.create({
  name: 'censored',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      token: { default: '' },
      // Transient Remove-censor target binding (never rendered, parsed or saved).
      removeId: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-censored]',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const token = el.getAttribute('data-token') ?? '';
          // Strict parseToken: a structurally-shaped but crypto-invalid token stays text.
          return isValidCensorToken(token) ? { token } : false;
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    // Only the placeholder (and the ciphertext token) ever reaches the DOM / clipboard HTML.
    const token = isValidCensorToken(node.attrs.token) ? domString(node.attrs.token) : '';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        ...(token ? { 'data-censored': '1', 'data-token': token } : {}),
        class: 'bk-censored-block',
        role: 'img',
        'aria-label': CENSORED_PLACEHOLDER,
      }),
      CENSORED_PLACEHOLDER,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CensoredView);
  },
});

// ---------------------------------------------------------------------------------------------
// Embed atom: click-to-load, credentialless iframe, always-present "Open in new tab" link.
// ---------------------------------------------------------------------------------------------

export function EmbedView({ node }: NodeViewProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const label = domString(node.attrs.label);
  const url = domString(node.attrs.url);
  const embed = parseEmbedUrl(url);
  const canPlay = browserSupportsCredentialless();
  const providerLabel =
    embed?.provider === 'youtube'
      ? t('notes.editor.embedProviderYoutube', { defaultValue: 'YouTube' })
      : t('notes.editor.embedProviderDrive', { defaultValue: 'Google Drive' });
  const frameTitle = label || providerLabel;
  // The EXACT canonical URL the user pressed Play on. A node whose URL changes afterwards (an
  // edit, undo, a paste) gets the card again: nothing is fetched from a URL nobody authorised.
  const [authorised, setAuthorised] = useState<string | null>(null);
  const playable = authorisedEmbed(authorised, url);
  const playing = playable !== null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!canPlay) return;
    const allowed = authorisedEmbed(authorised, url);
    if (!allowed) return;
    host.appendChild(createEmbedIframe(document, allowed, frameTitle));
    return () => {
      host.replaceChildren();
    };
  }, [authorised, canPlay, url, frameTitle]);

  if (!embed) {
    // Defensive: an embed node should only ever hold a validated URL. Show a safe link/text.
    return (
      <NodeViewWrapper as="div" className="bk-embed-card" contentEditable={false}>
        <span className="bk-embed-label">{label || url}</span>
      </NodeViewWrapper>
    );
  }
  const authorise = () => setAuthorised(embed.embedUrl);

  const openLink = (
    <a
      href={embed.openUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="bk-embed-open"
      contentEditable={false}
      onClick={(e) => e.stopPropagation()}
    >
      {t('notes.editor.embedOpen', { defaultValue: 'Open in new tab' })}
    </a>
  );

  if (playing && canPlay) {
    return (
      <NodeViewWrapper as="div" className="bk-embed-card" contentEditable={false}>
        <div ref={hostRef} className="bk-embed-frame-host" contentEditable={false} />
        <div className="bk-embed-footer">
          <span className="bk-embed-label">{label || providerLabel}</span>
          {openLink}
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="div" className="bk-embed-card" contentEditable={false}>
      <div className="bk-embed-head">
        <span className="bk-embed-provider">{providerLabel}</span>
        <span className="bk-embed-label">{label || embed.id}</span>
      </div>
      {canPlay ? (
        <button type="button" className="bk-embed-play" onClick={authorise}>
          ▶ {t('notes.editor.embedPlay', { defaultValue: 'Play' })}
        </button>
      ) : (
        <p className="bk-embed-unsupported">
          {t('notes.editor.embedUnsupported', {
            defaultValue: "Inline playback isn't supported in this browser. Use “Open in new tab”.",
          })}
        </p>
      )}
      <div className="bk-embed-footer">{openLink}</div>
    </NodeViewWrapper>
  );
}

export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { label: { default: '' }, url: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-embed]',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const url = el.getAttribute('data-url') ?? '';
          if (!isValidEmbedUrl(url)) return false;
          return { label: el.getAttribute('data-label') ?? '', url };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const url = domString(node.attrs.url);
    const label = domString(node.attrs.label);
    if (!isValidEmbedUrl(url)) return ['div', { class: 'bk-embed-card' }, label || url];
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-embed': '1',
        'data-label': label,
        'data-url': url,
        class: 'bk-embed-card',
      }),
      label || url,
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EmbedView);
  },
});

// ---------------------------------------------------------------------------------------------
// Transient upload placeholder (inline uploading / failed state). Never serialises to Markdown.
// ---------------------------------------------------------------------------------------------

function NoteUploadView({ node, deleteNode }: NodeViewProps) {
  const { t } = useTranslation();
  const failed = node.attrs.status === 'failed';
  const name = domString(node.attrs.filename);
  return (
    <NodeViewWrapper as="span" className="bk-upload" contentEditable={false}>
      <span role="status">
        {failed
          ? t('notes.editor.uploadFailed', { name, defaultValue: 'Upload failed: {{name}}' })
          : t('notes.editor.uploading', { name, defaultValue: 'Uploading {{name}}…' })}
      </span>
      <button
        type="button"
        aria-label={t('notes.editor.uploadRemove', { defaultValue: 'Remove upload' })}
        onClick={deleteNode}
      >
        ×
      </button>
    </NodeViewWrapper>
  );
}

export const NoteUpload = Node.create({
  name: 'noteUpload',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      uploadId: { default: '' },
      filename: { default: '' },
      status: { default: 'uploading' },
    };
  },
  parseHTML() {
    return []; // pasted placeholders never persist — they become plain text
  },
  renderHTML() {
    return ['span', { 'data-note-upload': '1', class: 'bk-upload' }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(NoteUploadView);
  },
});

export const noteNodes = [SafeLink, NoteImage, FileChip, InternalChip, Censored, Embed, NoteUpload];
