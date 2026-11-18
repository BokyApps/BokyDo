import { useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { lockCensored } from '../lib/notes-censor.js';
import { NoteDetail } from './notes/NoteDetail.js';
import { NotesList } from './notes/NotesList.js';

/**
 * `/notes` (list) and `/notes/$noteId` (editor) share one lazy route component.
 *
 * Leaving the notes section locks every censored span (keys, open password prompts, reveal
 * overlays) through the single `lockCensored` entry point. The app-level `pagehide` /
 * `visibilitychange → hidden` listener lives once in AppShell, so it also covers token pages and
 * task pages; this page only owns its own unmount.
 */
export function NotesPage() {
  const { noteId } = useParams({ strict: false });

  useEffect(() => () => lockCensored('unmount'), []);

  return noteId ? <NoteDetail noteId={noteId} /> : <NotesList />;
}
