import type { Appearance } from '@bokydo/shared';
import { cssVariables, FONTS, getTheme, TEXT_SIZES, type FontId } from '@bokydo/themes';

/** Each font's CSS is a separate lazily-loaded chunk: only the chosen one is ever downloaded. */
const FONT_LOADERS: Record<FontId, (() => Promise<unknown>) | null> = {
  system: null,
  inter: () => import('@fontsource-variable/inter/index.css'),
  'ibm-plex-sans': () =>
    Promise.all([
      import('@fontsource/ibm-plex-sans/400.css'),
      import('@fontsource/ibm-plex-sans/600.css'),
    ]),
  atkinson: () =>
    Promise.all([
      import('@fontsource/atkinson-hyperlegible/400.css'),
      import('@fontsource/atkinson-hyperlegible/700.css'),
    ]),
  lexend: () => import('@fontsource-variable/lexend/index.css'),
  opendyslexic: () =>
    Promise.all([
      import('@fontsource/opendyslexic/400.css'),
      import('@fontsource/opendyslexic/700.css'),
    ]),
  'jetbrains-mono': () => import('@fontsource-variable/jetbrains-mono/index.css'),
  'fira-code': () => import('@fontsource-variable/fira-code/index.css'),
};

const STORAGE_KEY = 'bokydo.appearance';
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Apply theme colours, font, size and density to the document (CSSOM only: CSP-safe). */
export function applyAppearance(appearance: Appearance): void {
  const mode = appearance.mode === 'system' ? (systemDark() ? 'dark' : 'light') : appearance.mode;
  const theme = getTheme(mode === 'dark' ? appearance.darkTheme : appearance.lightTheme, mode);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(cssVariables(theme)))
    root.style.setProperty(name, value);
  root.style.colorScheme = theme.mode;
  root.dataset.theme = theme.id;
  root.dataset.density = appearance.density;
  root.style.setProperty('--bk-text-size', TEXT_SIZES[appearance.textSize]);
  const font = FONTS.find((f) => f.id === appearance.font) ?? FONTS[0];
  void FONT_LOADERS[font.id]?.();
  root.style.setProperty('--bk-font', font.stack);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // storage unavailable: fine, it's only to avoid a flash on next load
  }
}

/** The last appearance used on this device (applied before sign-in to avoid a flash). */
export function cachedAppearance(): Appearance | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Appearance) : null;
  } catch {
    return null;
  }
}

/** Re-apply when the OS switches light/dark (for mode "system"). */
export function watchSystemMode(get: () => Appearance): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => applyAppearance(get());
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
