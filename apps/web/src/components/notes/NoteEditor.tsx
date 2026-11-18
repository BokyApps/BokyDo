import { getSchema, type Editor, type JSONContent } from '@tiptap/core';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EMPTY_CALLBACKS,
  getCallbacks,
  registerCallbacks,
  type NoteCallbacks,
  type RevealAnchor,
} from './callbacks.js';
import {
  clipboardTextSerializer,
  createDragCopyController,
  refuseCutIfCensored,
  type DragCopyController,
} from './clipboard.js';
import { docToMarkdown, markdownToDoc, sanitizeClipboardHtml } from './markdown.js';
import { noteNodes } from './nodes.js';
import { SourceMeta } from './source-meta.js';
import { safeTableExtensions } from './table.js';
import { Toolbar } from './Toolbar.js';
import { RevealOverlay, type RevealState } from './RevealOverlay.js';

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
  /** CONTRACT CHANGE: Reveal is fire-and-forget; the page owns the plaintext overlay. */
  onReveal?: (token: string, anchor: RevealAnchor) => void;
  onUncensor?: (token: string) => Promise<string | null>;
  /** Called when a Cut is refused because the selection contains a censored node. */
  onProtectedCut?: () => void;
  /** CONTRACT CHANGE: the page owns the reveal lifecycle and passes its state down. The overlay
   *  is rendered here (in the lazy editor chunk) via a portal to document.body — outside the
   *  editor root DOM. Keeping it in the lazy chunk avoids pulling react-dom into the entry. */
  revealState?: RevealState | null;
  onCloseReveal?: () => void;
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
    onProtectedCut: props.onProtectedCut,
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
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    ...safeTableExtensions,
    TaskList,
    TaskItem.configure({ nested: true }),
    SourceMeta,
    ...noteNodes,
  ];
}

const editorSchema = getSchema(buildExtensions());
const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [] }] };

export interface ParsedNote {
  doc: JSONContent;
  valid: boolean;
}

/**
 * Review fix (valid Markdown opens blank): validate the produced JSON against the real schema with
 * nodeFromJSON. On failure the page shows the raw Markdown in a read-only source view and blocks
 * saving from the WYSIWYG view. Empty text nodes are already stripped by markdownToDoc.
 */
export function parseForEditor(markdown: string): ParsedNote {
  try {
    const doc = markdownToDoc(markdown);
    editorSchema.nodeFromJSON(doc); // throws on any structure the editor would reject
    return { doc, valid: true };
  } catch {
    return { doc: EMPTY_DOC, valid: false };
  }
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
  const { markdown, editable = true, revealState, onCloseReveal } = props;
  const { t } = useTranslation();
  const [markdownMode, setMarkdownMode] = useState(false);

  // The overlay is portaled to document.body, so its DOM is outside the editor root entirely.
  const overlay = revealState ? (
    <RevealOverlay
      plaintext={revealState.plaintext}
      anchor={revealState.anchor}
      onClose={onCloseReveal ?? (() => {})}
    />
  ) : null;

  // Refs are only written/read in effects and event handlers (never during render), which the
  // React 19 `react-hooks/refs` rule requires. TipTap refreshes its options on every render, so
  // the editor's onUpdate/handlePaste closures always see the latest ref values.
  const onChangeRef = useRef(props.onChange);
  const callbacksRef = useRef<NoteCallbacks>(EMPTY_CALLBACKS);
  const editorRef = useRef<Editor | null>(null);
  const lastEmitted = useRef<string | null>(null);
  const applyingExternal = useRef(false);
  const dragRef = useRef<DragCopyController>(createDragCopyController());

  // A fresh callbacks object for the Toolbar each render (it is used in event handlers there).
  const callbacks = toCallbacks(props);

  // Parse once on init (and only on genuine external changes in the effect below) — never on every
  // render/echo, which used to re-parse a 500 KB table on each keystroke (~480 ms).
  const [initial] = useState<ParsedNote>(() => parseForEditor(markdown));
  const [safeMode, setSafeMode] = useState(!initial.valid);
  const safeModeRef = useRef(safeMode);
  const [extensions] = useState(buildExtensions);

  const editor = useEditor(
    {
      extensions,
      content: initial.doc,
      editable: initial.valid && editable,
      injectCSS: false, // strict CSP: no injected <style>; all editor CSS lives in index.css
      editorProps: {
        attributes: { class: 'bk-note-prosemirror', spellcheck: 'true' },
        clipboardTextSerializer: (slice) => clipboardTextSerializer(slice),
        transformCopied: (slice, view) => dragRef.current.transformCopied(slice, view.state.schema),
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
        handleDOMEvents: {
          // Internal drags keep the real censored node (tokens), so moving it does not turn it into
          // the █████ placeholder. Return false so ProseMirror's own drag handling still runs.
          dragstart: () => {
            dragRef.current.markDragStart();
            return false;
          },
          dragend: () => {
            dragRef.current.markDragEnd();
            return false;
          },
          // A Cut of a selection containing a censored node is refused: prevent default, notify,
          // and do NOT delete (so the atom/token survives).
          cut: (_view, event) => {
            const current = editorRef.current;
            if (!current) return false;
            const refused = refuseCutIfCensored(current.state.selection.content(), () =>
              callbacksRef.current.onProtectedCut?.(),
            );
            if (!refused) return false;
            event.preventDefault();
            return true; // handled: ProseMirror must not delete the selection
          },
        },
      },
      onUpdate: ({ editor: instance }) => {
        if (applyingExternal.current) return;
        if (safeModeRef.current) return; // safe mode: block WYSIWYG onChange entirely
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
    safeModeRef.current = safeMode;
    if (editor) registerCallbacks(editor, callbacksRef);
  });

  // External changes to `markdown` (or edits made in the textarea) flow into the editor without
  // emitting a change event, so typing in WYSIWYG never resets the cursor. Echoes of our own
  // onChange are skipped, so a genuine re-parse happens only for real external updates. While the
  // Markdown source view is open we do not reload on each keystroke; leaving it applies the whole
  // edit as a single undo boundary.
  useEffect(() => {
    if (!editor) return;
    if (markdown === lastEmitted.current) return;
    if (markdownMode) return;
    const parsed = parseForEditor(markdown);
    const invalid = !parsed.valid;
    if (invalid !== safeMode) {
      // A genuine external change flips safe mode once; guarded, so it is not a cascading render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSafeMode(invalid);
      safeModeRef.current = invalid;
    }
    if (invalid) return;
    if (docToMarkdown(editor.getJSON()) === markdown) return;
    applyingExternal.current = true;
    try {
      editor.commands.setContent(parsed.doc, { emitUpdate: false });
    } finally {
      applyingExternal.current = false;
    }
    lastEmitted.current = markdown;
  }, [markdown, editor, markdownMode, safeMode]);

  useEffect(() => {
    if (editor) editor.setEditable(editable && !safeMode, false);
  }, [editable, safeMode, editor]);

  const pickFiles = (files: File[]) => {
    const current = editorRef.current;
    if (current) void insertFiles(files, current, callbacks);
  };

  // Safe mode: the produced JSON failed schema validation. Show the raw Markdown in the source
  // view, keep the WYSIWYG editor read-only and hidden, and block WYSIWYG saving with a notice.
  if (safeMode) {
    return (
      <>
        <div className="bk-note-editor">
          <p className="bk-toolbar-error" role="alert">
            {t('notes.editor.invalidSource', {
              defaultValue:
                "This note's Markdown can't be shown in the editor. Fix it in the source view below.",
            })}
          </p>
          <textarea
            className="bk-note-textarea"
            aria-label={t('notes.editor.markdownViewLabel', { defaultValue: 'Markdown source' })}
            value={markdown}
            readOnly={!editable}
            spellCheck={false}
            onChange={(e) => onChangeRef.current(e.target.value)}
          />
        </div>
        {overlay}
      </>
    );
  }

  return (
    <>
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
      {overlay}
    </>
  );
}

export default NoteEditor;
