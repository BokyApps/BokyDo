import { Mark, mergeAttributes, Node, type NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCallbacks } from './callbacks.js';
import { browserSupportsCredentialless, parseEmbedUrl } from './embed.js';
import { CENSORED_PLACEHOLDER, classifyHref, markdownToInline } from './markdown.js';

const NOTE_FILE_SRC = /^\/api\/v1\/note-files\/[0-9a-fA-F-]{36}$/;

function domString(value: unknown): string {
  return value == null ? '' : String(value);
}

// ---------------------------------------------------------------------------------------------
// Link mark (safeHref only). Unsafe hrefs are dropped on parse AND on paste by returning false.
// ---------------------------------------------------------------------------------------------

export const SafeLink = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes() {
    return { href: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'a[href]',
        getAttrs: (el) => {
          if (typeof el === 'string') return false;
          const href = el.getAttribute('href') ?? '';
          const cls = classifyHref(href);
          return cls.kind === 'link' ? { href: cls.href } : false;
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
// Note-file image: only /api/v1/note-files/<uuid> is ever rendered as an <img>.
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
          const id = el.getAttribute('data-id') ?? '';
          const cls = classifyHref(src.replace('?inline=1', ''));
          const fileId =
            cls.kind === 'file' ? cls.id : NOTE_FILE_SRC.test(id) ? id.slice(-36) : null;
          return fileId ? { id: fileId, alt: el.getAttribute('alt') ?? '' } : false;
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        'data-note-image': '1',
        'data-id': domString(node.attrs.id),
        src: `/api/v1/note-files/${domString(node.attrs.id)}?inline=1`,
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
        getAttrs: (el) =>
          typeof el === 'string'
            ? false
            : { id: el.getAttribute('data-id') ?? '', name: el.textContent ?? '' },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const name = domString(node.attrs.name) || 'file';
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-file-chip': '1',
        'data-id': domString(node.attrs.id),
        href: `/api/v1/note-files/${domString(node.attrs.id)}`,
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
        getAttrs: (el) =>
          typeof el === 'string'
            ? false
            : {
                kind: el.getAttribute('data-kind') === 'task' ? 'task' : 'note',
                id: el.getAttribute('data-id') ?? '',
                label: el.getAttribute('data-label') ?? '',
              },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-internal-chip': '1',
        'data-kind': domString(node.attrs.kind),
        'data-id': domString(node.attrs.id),
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
// document. "Reveal" shows cleartext in a transient, non-selectable overlay (see below).
// ---------------------------------------------------------------------------------------------

interface RevealOverlayProps {
  plaintext: string;
  onClose: () => void;
}

/** Presentational overlay, exported for headless tests. Not part of the ProseMirror document. */
export function RevealOverlay({ plaintext, onClose }: RevealOverlayProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const timer = window.setTimeout(onClose, 60_000);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="bk-reveal-overlay select-none"
      contentEditable={false}
      role="status"
      tabIndex={-1}
      onBlur={onClose}
      data-testid="reveal-overlay"
    >
      <span className="bk-reveal-text">{plaintext}</span>
      <button type="button" contentEditable={false} onClick={onClose} className="bk-reveal-close">
        {t('notes.editor.censorClose', { defaultValue: 'Close' })}
      </button>
    </div>
  );
}

function CensoredView({ node, editor, getPos, deleteNode }: NodeViewProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const token = domString(node.attrs.token);
  const closeReveal = useCallback(() => setRevealed(null), []);

  const reveal = async () => {
    setMenuOpen(false);
    const cb = getCallbacks(editor);
    if (!cb.onReveal) return;
    const plaintext = await cb.onReveal(token);
    if (plaintext != null) setRevealed(plaintext);
  };

  const removeCensor = async () => {
    setMenuOpen(false);
    const cb = getCallbacks(editor);
    if (!cb.onUncensor) return;
    const plaintext = await cb.onUncensor(token);
    if (plaintext == null) return;
    const inline = markdownToInline(plaintext);
    const from = getPos();
    if (typeof from !== 'number') return;
    const to = from + node.nodeSize;
    if (inline.length === 0) {
      deleteNode();
    } else {
      editor.chain().focus().insertContentAt({ from, to }, inline).run();
    }
  };

  return (
    <NodeViewWrapper as="span" className="bk-censored-wrap">
      <span
        role="img"
        aria-label={t('notes.editor.censoredAriaLabel', { defaultValue: 'Censored text' })}
        className="bk-censored-block"
        contentEditable={false}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {CENSORED_PLACEHOLDER}
      </span>
      {menuOpen && (
        <span className="bk-censor-menu" contentEditable={false}>
          <button type="button" onClick={() => void reveal()}>
            {t('notes.editor.censorReveal', { defaultValue: 'Reveal' })}
          </button>
          <button type="button" onClick={() => void removeCensor()}>
            {t('notes.editor.censorRemove', { defaultValue: 'Remove censor' })}
          </button>
        </span>
      )}
      {revealed !== null && <RevealOverlay plaintext={revealed} onClose={closeReveal} />}
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
    return { token: { default: '' } };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-censored]',
        getAttrs: (el) =>
          typeof el === 'string' ? false : { token: el.getAttribute('data-token') ?? '' },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    // Only the placeholder ever reaches the DOM / clipboard HTML — never cleartext.
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-censored': '1',
        'data-token': domString(node.attrs.token),
        class: 'bk-censored-block',
        role: 'img',
        'aria-label': 'Censored text',
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

function EmbedView({ node }: NodeViewProps) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const label = domString(node.attrs.label);
  const url = domString(node.attrs.url);
  const embed = parseEmbedUrl(url);

  useEffect(() => {
    if (playing && iframeRef.current) iframeRef.current.setAttribute('credentialless', '');
  }, [playing]);

  if (!embed) {
    // Defensive: an embed node should only ever hold a validated URL. Show a safe link/text.
    return (
      <NodeViewWrapper as="div" className="bk-embed-card" contentEditable={false}>
        <span className="bk-embed-label">{label || url}</span>
      </NodeViewWrapper>
    );
  }

  const canPlay = browserSupportsCredentialless();
  const providerLabel =
    embed.provider === 'youtube'
      ? t('notes.editor.embedProviderYoutube', { defaultValue: 'YouTube' })
      : t('notes.editor.embedProviderDrive', { defaultValue: 'Google Drive' });
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
        <iframe
          ref={iframeRef}
          src={embed.embedUrl}
          title={label || providerLabel}
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="encrypted-media; picture-in-picture; fullscreen"
          loading="lazy"
          className="bk-embed-frame"
        />
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
        <button type="button" className="bk-embed-play" onClick={() => setPlaying(true)}>
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
        getAttrs: (el) =>
          typeof el === 'string'
            ? false
            : {
                label: el.getAttribute('data-label') ?? '',
                url: el.getAttribute('data-url') ?? '',
              },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-embed': '1',
        'data-label': domString(node.attrs.label),
        'data-url': domString(node.attrs.url),
        class: 'bk-embed-card',
      }),
      domString(node.attrs.label) || domString(node.attrs.url),
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
  renderHTML({ node }) {
    return [
      'span',
      { 'data-note-upload': '1', class: 'bk-upload' },
      node.attrs.status === 'failed' ? 'Upload failed' : 'Uploading…',
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(NoteUploadView);
  },
});

export const noteNodes = [SafeLink, NoteImage, FileChip, InternalChip, Censored, Embed, NoteUpload];
