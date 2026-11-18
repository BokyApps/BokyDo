import type { Editor } from '@tiptap/core';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EMPTY_CALLBACKS,
  getCallbacks,
  registerCallbacks,
  type NoteCallbacks,
} from './callbacks.js';
import { censorSlice, clipboardTextSerializer } from './clipboard.js';
import { docToMarkdown, markdownToDoc, sanitizeClipboardHtml } from './markdown.js';
import { noteNodes } from './nodes.js';
import { Toolbar } from './Toolbar.js';

export interface NoteEditorProps {
  markdown: string;
  onChange: (markdown: string) => void;
  editable?: boolean;
  /** Upload a pasted/dropped/picked file; resolves to its note-file id. */
  onUploadFile?: (file: File) => Promise<{ id: string; filename: string; contentType: string }>;
  /** Navigate to an internal target (bokydo:note/<id> or bokydo:task/<id>). */
  onOpenInternal?: (kind: 'note' | 'task', id: string) => void;
  /** Search callbacks for the link picker. */
  searchNotes?: (q: string) => Promise<{ id: string; title: string }[]>;
  searchTasks?: (q: string) => Promise<{ id: string; content: string }[]>;
  /** Censor hooks (crypto is supplied by the caller; the editor never stores passwords). */
  onCensor?: (plaintextMarkdown: string) => Promise<string | null>;
  onReveal?: (token: string) => Promise<string | null>;
  onUncensor?: (token: string) => Promise<string | null>;
}

function toCallbacks(props: NoteEditorProps): NoteCallbacks {
  return {
    onUploadFile: props.onUploadFile,
    onOpenInternal: props.onOpenInternal,
    searchNotes: props.searchNotes,
    searchTasks: props.searchTasks,
    onCensor: props.onCensor,
    onReveal: props.onReveal,
    onUncensor: props.onUncensor,
  };
}

export function buildExtensions() {
  return [
    StarterKit.configure({
      // Strict URL handling is done by our own SafeLink mark; disable the stock ones and the
      // trailing-node helper (which would inject an empty paragraph that breaks round-trips).
      link: false,
      underline: false,
      trailingNode: false,
      heading: { levels: [1, 2, 3] },
    }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    ...noteNodes,
  ];
}

// ---------------------------------------------------------------------------------------------
// File upload helpers (paste / drop / picker). A transient inline placeholder shows progress and
// is replaced with an image or file chip once onUploadFile resolves.
// ---------------------------------------------------------------------------------------------

type UploadResult = { id: string; filename: string; contentType: string };

function findUploadPos(editor: Editor, uploadId: string): number | null {
  let pos: number | null = null;
  editor.state.doc.descendants((node, p) => {
    if (node.type.name === 'noteUpload' && node.attrs.uploadId === uploadId) {
      pos = p;
      return false;
    }
    return true;
  });
  return pos;
}

function replaceUploadWithFile(editor: Editor, uploadId: string, res: UploadResult): void {
  const pos = findUploadPos(editor, uploadId);
  if (pos === null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const content = res.contentType.startsWith('image/')
    ? { type: 'noteImage', attrs: { id: res.id, alt: res.filename } }
    : { type: 'fileChip', attrs: { id: res.id, name: res.filename } };
  editor
    .chain()
    .insertContentAt({ from: pos, to: pos + node.nodeSize }, content)
    .run();
}

function setUploadFailed(editor: Editor, uploadId: string): void {
  const pos = findUploadPos(editor, uploadId);
  if (pos === null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, status: 'failed' }),
  );
}

async function insertFiles(files: File[], editor: Editor, callbacks: NoteCallbacks): Promise<void> {
  if (!callbacks.onUploadFile) return;
  for (const file of files) {
    const uploadId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'noteUpload',
        attrs: { uploadId, filename: file.name, status: 'uploading' },
      })
      .run();
    try {
      const res = await callbacks.onUploadFile(file);
      replaceUploadWithFile(editor, uploadId, res);
    } catch {
      setUploadFailed(editor, uploadId);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

/**
 * WYSIWYG Markdown note editor. `markdown` is the source of truth: on every document change the
 * editor emits canonical Markdown (never HTML). A small toggle reveals a monospace textarea with
 * the exact Markdown; edits in either view sync through the parent's `markdown` value.
 *
 * The editor is only ever imported from the notes page (via React.lazy), so TipTap, ProseMirror
 * and markdown-it land in their own lazy chunk and never bloat the entry bundle.
 */
export function NoteEditor(props: NoteEditorProps) {
  const { markdown, editable = true } = props;
  const { t } = useTranslation();
  const [markdownMode, setMarkdownMode] = useState(false);

  // Refs are only written/read in effects and event handlers (never during render), which the
  // React 19 `react-hooks/refs` rule requires. TipTap refreshes its options on every render, so
  // the editor's onUpdate/handlePaste closures always see the latest ref values.
  const onChangeRef = useRef(props.onChange);
  const callbacksRef = useRef<NoteCallbacks>(EMPTY_CALLBACKS);
  const editorRef = useRef<Editor | null>(null);
  const lastEmitted = useRef<string | null>(null);
  const applyingExternal = useRef(false);

  // A fresh callbacks object for the Toolbar each render (it is used in event handlers there).
  const callbacks = toCallbacks(props);

  const [extensions] = useState(buildExtensions);

  const editor = useEditor(
    {
      extensions,
      content: markdownToDoc(markdown),
      editable,
      injectCSS: false, // strict CSP: no injected <style>; all editor CSS lives in index.css
      editorProps: {
        attributes: { class: 'bk-note-prosemirror', spellcheck: 'true' },
        clipboardTextSerializer: (slice) => clipboardTextSerializer(slice),
        transformCopied: (slice, view) => censorSlice(slice, view.state.schema),
        transformPastedHTML: (html) => sanitizeClipboardHtml(html),
        handlePaste: (_view, event) => {
          const current = editorRef.current;
          const files = event.clipboardData?.files;
          if (!current || !files || files.length === 0) return false;
          void insertFiles(Array.from(files), current, getCallbacks(current));
          return true;
        },
        handleDrop: (view, event) => {
          const current = editorRef.current;
          const drag = event as DragEvent;
          const files = drag.dataTransfer?.files;
          if (!current || !files || files.length === 0) return false;
          event.preventDefault();
          const coords = view.posAtCoords({ left: drag.clientX, top: drag.clientY });
          if (coords) current.chain().setTextSelection(coords.pos).run();
          void insertFiles(Array.from(files), current, getCallbacks(current));
          return true;
        },
      },
      onUpdate: ({ editor: instance }) => {
        if (applyingExternal.current) return;
        const md = docToMarkdown(instance.getJSON());
        lastEmitted.current = md;
        onChangeRef.current(md);
      },
    },
    [],
  );

  // Keep all refs current after every render and register the callbacks bridge with the editor.
  useEffect(() => {
    onChangeRef.current = props.onChange;
    callbacksRef.current = callbacks;
    editorRef.current = editor;
    if (editor) registerCallbacks(editor, callbacksRef);
  });

  // External changes to `markdown` (or edits made in the textarea) flow into the editor without
  // emitting a change event, so typing in WYSIWYG never resets the cursor.
  useEffect(() => {
    if (!editor) return;
    if (markdown === lastEmitted.current) return;
    if (docToMarkdown(editor.getJSON()) === markdown) return;
    applyingExternal.current = true;
    try {
      editor.commands.setContent(markdownToDoc(markdown), { emitUpdate: false });
    } finally {
      applyingExternal.current = false;
    }
    lastEmitted.current = markdown;
  }, [markdown, editor]);

  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editable, editor]);

  const pickFiles = (files: File[]) => {
    const current = editorRef.current;
    if (current) void insertFiles(files, current, callbacks);
  };

  return (
    <div className="bk-note-editor">
      <Toolbar
        editor={editor}
        editable={editable}
        markdownMode={markdownMode}
        onToggleMarkdown={() => setMarkdownMode((mode) => !mode)}
        onPickFiles={pickFiles}
        callbacks={callbacks}
      />
      <div
        hidden={markdownMode}
        className="bk-wysiwyg-wrap"
        aria-label={t('notes.editor.editorLabel', { defaultValue: 'Note editor' })}
      >
        <EditorContent editor={editor} />
      </div>
      {markdownMode && (
        <textarea
          className="bk-note-textarea"
          aria-label={t('notes.editor.markdownViewLabel', { defaultValue: 'Markdown source' })}
          value={markdown}
          readOnly={!editable}
          spellCheck={false}
          onChange={(e) => onChangeRef.current(e.target.value)}
        />
      )}
    </div>
  );
}

export default NoteEditor;
