import { useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { lockCensors } from '../lib/notes-censor.js';
import { NoteDetail } from './notes/NoteDetail.js';
import { NotesList } from './notes/NotesList.js';

/**
 * `/notes` (list) and `/notes/$noteId` (editor) share one lazy route component. One pagehide
 * listener clears the censor key cache, password inputs and any open reveal overlay for the whole
 * notes section; Lock and sign-out clear them too (see notes-censor.ts / AppShell).
 */
export function NotesPage() {
  const { noteId } = useParams({ strict: false });

  useEffect(() => {
    const onHide = () => lockCensors();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  return noteId ? <NoteDetail noteId={noteId} /> : <NotesList />;
}
