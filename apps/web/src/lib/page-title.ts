const APP = 'BokyDo';
const MAX = 80;

/** The document title for a page: its main heading, then the app name ("Today – BokyDo"). */
export function pageTitle(heading: string | null | undefined): string {
  const text = (heading ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.toLowerCase() === APP.toLowerCase()) return APP;
  return `${text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text} – ${APP}`;
}
