import type { Editor } from '@tiptap/core';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NoteCallbacks } from './callbacks.js';
import { censorSelection, censorableSelection } from './censor-command.js';
import { parseEmbedUrl } from './embed.js';
import { classifyHref } from './markdown.js';

interface ToolbarProps {
  editor: Editor | null;
  editable: boolean;
  markdownMode: boolean;
  onToggleMarkdown: () => void;
  onPickFiles: (files: File[]) => void;
  callbacks: NoteCallbacks;
}

interface PickerResult {
  id: string;
  label: string;
}

export function Toolbar({
  editor,
  editable,
  markdownMode,
  onToggleMarkdown,
  onPickFiles,
  callbacks,
}: ToolbarProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState(false);

  const [embedOpen, setEmbedOpen] = useState(false);
  const [embedUrl, setEmbedUrl] = useState('');
  const [embedLabel, setEmbedLabel] = useState('');
  const [embedError, setEmbedError] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState<'note' | 'task'>('note');
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerResults, setPickerResults] = useState<PickerResult[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  const [censorError, setCensorError] = useState<string | null>(null);

  const disabled = !editor || !editable || markdownMode;

  const button = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    extraDisabled = false,
  ): ReactNode => (
    <button
      type="button"
      className="bk-tool-button"
      aria-label={label}
      title={label}
      disabled={disabled || extraDisabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  const chain = () => editor?.chain().focus();
  const closeAll = () => {
    setLinkOpen(false);
    setEmbedOpen(false);
    setPickerOpen(false);
  };

  // --- simple commands ----------------------------------------------------------------------
  const toggle = (command: string, arg?: Record<string, unknown>) => {
    if (!editor) return;
    const c = chain();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic chain command name
    const fn = (c as any)?.[command];
    if (typeof fn === 'function') (arg ? fn.call(c, arg) : fn.call(c)).run();
  };

  const selectedText = (): string => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, ' ');
  };

  // --- link dialog --------------------------------------------------------------------------
  const applyLink = () => {
    if (!editor) return;
    const value = linkUrl.trim();
    const cls = classifyHref(value);
    if (cls.kind === 'unsafe') {
      setLinkError(true);
      return;
    }
    const label = selectedText();
    if (cls.kind === 'link') {
      if (label) editor.chain().focus().setMark('link', { href: cls.href }).run();
      else
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'text',
            text: cls.href,
            marks: [{ type: 'link', attrs: { href: cls.href } }],
          })
          .run();
    } else if (cls.kind === 'file') {
      editor
        .chain()
        .focus()
        .insertContent({ type: 'fileChip', attrs: { id: cls.id, name: label || value } })
        .run();
    } else {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'internalChip',
          attrs: { kind: cls.kind, id: cls.id, label: label || cls.id },
        })
        .run();
    }
    setLinkOpen(false);
    setLinkError(false);
    setLinkUrl('');
  };

  // --- embed dialog -------------------------------------------------------------------------
  const applyEmbed = () => {
    if (!editor) return;
    const url = embedUrl.trim();
    if (!parseEmbedUrl(url)) {
      setEmbedError(true);
      return;
    }
    // Labels are escaped by the Markdown writer (E5), so `]`, `[` and `\` survive the round trip.
    const label = embedLabel.trim();
    editor.chain().focus().insertContent({ type: 'embed', attrs: { label, url } }).run();
    setEmbedOpen(false);
    setEmbedError(false);
    setEmbedUrl('');
    setEmbedLabel('');
  };

  // --- note/task picker ---------------------------------------------------------------------
  const runSearch = async (kind: 'note' | 'task', q: string) => {
    const seq = ++searchSeq.current;
    setPickerLoading(true);
    try {
      if (kind === 'note') {
        const raw = callbacks.searchNotes ? await callbacks.searchNotes(q) : [];
        if (seq === searchSeq.current)
          setPickerResults(raw.map((r) => ({ id: r.id, label: r.title })));
      } else {
        const raw = callbacks.searchTasks ? await callbacks.searchTasks(q) : [];
        if (seq === searchSeq.current)
          setPickerResults(raw.map((r) => ({ id: r.id, label: r.content })));
      }
    } finally {
      if (seq === searchSeq.current) setPickerLoading(false);
    }
  };

  const openPicker = (kind: 'note' | 'task') => {
    setPickerKind(kind);
    setPickerQuery('');
    setPickerResults([]);
    setPickerOpen(true);
    void runSearch(kind, '');
  };

  const onPickerQuery = (q: string) => {
    setPickerQuery(q);
    void runSearch(pickerKind, q);
  };

  const pick = (id: string, label: string) => {
    editor
      ?.chain()
      .focus()
      .insertContent({ type: 'internalChip', attrs: { kind: pickerKind, id, label } })
      .run();
    setPickerOpen(false);
  };

  // --- censor -------------------------------------------------------------------------------
  const censor = async () => {
    if (!editor || !callbacks.onCensor) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) {
      setCensorError(
        t('notes.editor.censorEmpty', { defaultValue: 'Select some text to censor first.' }),
      );
      return;
    }
    // Reject before opening the password prompt: a token inside a code block, an embed or another
    // atom cannot survive a reload as an atom, so it must never be reported as a success.
    if (!censorableSelection(editor, from, to)) {
      setCensorError(
        t('notes.editor.censorUnsupported', {
          defaultValue:
            'Only text in a paragraph, heading, list, quote or table cell can be censored — not a code block, an embed or another atom.',
        }),
      );
      return;
    }
    setCensorError(null);
    // censorSelection makes the editor read-only while the password prompt is open, aborts if the
    // document changed (stale selection), verifies the token survives a save, and wipes undo
    // history so plaintext can't be restored.
    const outcome = await censorSelection(editor, from, to, callbacks.onCensor);
    callbacks.onCensorSettled?.(outcome);
    if (outcome === 'aborted') {
      setCensorError(
        t('notes.editor.censorAborted', {
          defaultValue: 'The note changed while censoring. Nothing was changed — please try again.',
        }),
      );
    } else if (outcome === 'unsupported') {
      setCensorError(
        t('notes.editor.censorUnsupported', {
          defaultValue:
            'Only text in a paragraph, heading, list, quote or table cell can be censored — not a code block, an embed or another atom.',
        }),
      );
    }
  };

  return (
    <div className="bk-note-toolbar-wrap">
      <div
        role="toolbar"
        aria-label={t('notes.editor.toolbarLabel', { defaultValue: 'Note formatting' })}
        className="bk-note-toolbar"
      >
        {button(t('notes.editor.paragraph', { defaultValue: 'Normal text' }), '¶', () =>
          toggle('setParagraph'),
        )}
        {button(t('notes.editor.heading1', { defaultValue: 'Heading 1' }), 'H1', () =>
          toggle('toggleHeading', { level: 1 }),
        )}
        {button(t('notes.editor.heading2', { defaultValue: 'Heading 2' }), 'H2', () =>
          toggle('toggleHeading', { level: 2 }),
        )}
        {button(t('notes.editor.heading3', { defaultValue: 'Heading 3' }), 'H3', () =>
          toggle('toggleHeading', { level: 3 }),
        )}
        <span className="bk-tool-sep" aria-hidden="true" />
        {button(t('notes.editor.bold', { defaultValue: 'Bold' }), 'B', () => toggle('toggleBold'))}
        {button(t('notes.editor.italic', { defaultValue: 'Italic' }), 'I', () =>
          toggle('toggleItalic'),
        )}
        {button(t('notes.editor.strike', { defaultValue: 'Strikethrough' }), 'S', () =>
          toggle('toggleStrike'),
        )}
        {button(t('notes.editor.code', { defaultValue: 'Inline code' }), '<>', () =>
          toggle('toggleCode'),
        )}
        {button(t('notes.editor.codeBlock', { defaultValue: 'Code block' }), '{ }', () =>
          toggle('toggleCodeBlock'),
        )}
        <span className="bk-tool-sep" aria-hidden="true" />
        {button(t('notes.editor.bulletList', { defaultValue: 'Bullet list' }), '•', () =>
          toggle('toggleBulletList'),
        )}
        {button(t('notes.editor.orderedList', { defaultValue: 'Numbered list' }), '1.', () =>
          toggle('toggleOrderedList'),
        )}
        {button(t('notes.editor.taskList', { defaultValue: 'Task list' }), '☑', () =>
          toggle('toggleTaskList'),
        )}
        {button(t('notes.editor.quote', { defaultValue: 'Quote' }), '❝', () =>
          toggle('toggleBlockquote'),
        )}
        {button(t('notes.editor.horizontalRule', { defaultValue: 'Divider' }), '—', () =>
          toggle('setHorizontalRule'),
        )}
        <span className="bk-tool-sep" aria-hidden="true" />
        {button(t('notes.editor.link', { defaultValue: 'Add link' }), '🔗', () => {
          closeAll();
          setLinkOpen(true);
        })}
        {button(t('notes.editor.linkNote', { defaultValue: 'Link to note or task' }), '⤴', () =>
          openPicker('note'),
        )}
        {button(t('notes.editor.uploadFile', { defaultValue: 'Upload file' }), '📎', () =>
          fileInputRef.current?.click(),
        )}
        {button(t('notes.editor.embed', { defaultValue: 'Embed video' }), '▶', () => {
          closeAll();
          setEmbedOpen(true);
        })}
        {button(
          t('notes.editor.censor', { defaultValue: 'Censor selection' }),
          '██',
          () => void censor(),
        )}
        <span className="bk-tool-sep" aria-hidden="true" />
        <button
          type="button"
          className="bk-tool-button bk-md-toggle"
          aria-label={t('notes.editor.markdownToggle', { defaultValue: 'Toggle Markdown view' })}
          title={t('notes.editor.markdownToggle', { defaultValue: 'Toggle Markdown view' })}
          aria-pressed={markdownMode}
          onClick={onToggleMarkdown}
        >
          MD
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onPickFiles(files);
          e.target.value = '';
        }}
      />

      {linkOpen && (
        <div
          className="bk-toolbar-panel"
          role="group"
          aria-label={t('notes.editor.link', { defaultValue: 'Add link' })}
        >
          <label>
            {t('notes.editor.linkUrlLabel', { defaultValue: 'Link URL' })}
            <input
              type="text"
              value={linkUrl}
              onChange={(e) => {
                setLinkUrl(e.target.value);
                setLinkError(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && applyLink()}
            />
          </label>
          {linkError && (
            <p className="bk-toolbar-error">
              {t('notes.editor.linkInvalid', {
                defaultValue: 'Only http(s), mailto, or BokyDo links are allowed.',
              })}
            </p>
          )}
          <div className="bk-toolbar-actions">
            <button type="button" onClick={applyLink}>
              {t('notes.editor.apply', { defaultValue: 'Apply' })}
            </button>
            <button type="button" onClick={() => setLinkOpen(false)}>
              {t('notes.editor.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
        </div>
      )}

      {embedOpen && (
        <div
          className="bk-toolbar-panel"
          role="group"
          aria-label={t('notes.editor.embed', { defaultValue: 'Embed video' })}
        >
          <label>
            {t('notes.editor.embedUrlLabel', { defaultValue: 'Video URL' })}
            <input
              type="text"
              value={embedUrl}
              onChange={(e) => {
                setEmbedUrl(e.target.value);
                setEmbedError(false);
              }}
            />
          </label>
          <label>
            {t('notes.editor.embedLabelLabel', { defaultValue: 'Label (optional)' })}
            <input type="text" value={embedLabel} onChange={(e) => setEmbedLabel(e.target.value)} />
          </label>
          {embedError && (
            <p className="bk-toolbar-error">
              {t('notes.editor.embedInvalid', {
                defaultValue: 'Only YouTube and Google Drive links can be embedded.',
              })}
            </p>
          )}
          <div className="bk-toolbar-actions">
            <button type="button" onClick={applyEmbed}>
              {t('notes.editor.embedAdd', { defaultValue: 'Add embed' })}
            </button>
            <button type="button" onClick={() => setEmbedOpen(false)}>
              {t('notes.editor.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
        </div>
      )}

      {pickerOpen && (
        <div
          className="bk-toolbar-panel"
          role="group"
          aria-label={t('notes.editor.pickerLabel', { defaultValue: 'Link to a note or task' })}
        >
          <div className="bk-picker-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={pickerKind === 'note'}
              onClick={() => {
                setPickerKind('note');
                setPickerQuery('');
                void runSearch('note', '');
              }}
            >
              {t('notes.editor.pickerNotes', { defaultValue: 'Notes' })}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={pickerKind === 'task'}
              onClick={() => {
                setPickerKind('task');
                setPickerQuery('');
                void runSearch('task', '');
              }}
            >
              {t('notes.editor.pickerTasks', { defaultValue: 'Tasks' })}
            </button>
          </div>
          <input
            type="search"
            value={pickerQuery}
            placeholder={t('notes.editor.pickerSearch', { defaultValue: 'Search' })}
            aria-label={t('notes.editor.pickerSearchAria', {
              defaultValue: 'Search notes or tasks',
            })}
            onChange={(e) => onPickerQuery(e.target.value)}
          />
          {pickerLoading && (
            <p role="status">{t('notes.editor.pickerLoading', { defaultValue: 'Searching…' })}</p>
          )}
          {!pickerLoading && pickerResults.length === 0 && (
            <p>{t('notes.editor.pickerEmpty', { defaultValue: 'No results' })}</p>
          )}
          <ul className="bk-picker-results">
            {pickerResults.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => pick(r.id, r.label)}>
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="bk-toolbar-actions">
            <button type="button" onClick={() => setPickerOpen(false)}>
              {t('notes.editor.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
        </div>
      )}

      {censorError && (
        <p className="bk-toolbar-error" role="alert">
          {censorError}
        </p>
      )}
    </div>
  );
}
