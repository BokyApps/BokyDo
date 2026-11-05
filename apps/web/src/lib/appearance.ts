import { appearanceSchema, type Appearance } from '@bokydo/shared';
import { cssVariables, FONTS, getTheme, TEXT_SIZES, type FontId } from '@bokydo/themes';

/** Base UI/code fonts are bundled in the shell; other families load on demand. */
const FONT_LOADERS: Record<FontId, () => Promise<unknown>> = {
  inter: () => Promise.resolve(),
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
  'jetbrains-mono': () => Promise.resolve(),
  'fira-code': () => import('@fontsource-variable/fira-code/index.css'),
};

// Cache in-flight loads too: preference updates and rapid clicks share the same font request.
const fontLoads = new Map<FontId, Promise<void>>();
let fontRevision = 0;

async function loadFont(id: FontId): Promise<void> {
  const existing = fontLoads.get(id);
  if (existing) return existing;
  const font = FONTS.find((entry) => entry.id === id) ?? FONTS[0];
  const unquote = (value: string) => value.replaceAll('"', '').replaceAll("'", '').trim();
  const family = unquote(font.stack.split(',')[0] ?? '');
  const loaded = (async () => {
    await FONT_LOADERS[id]();
    // Fontsource splits families into unicode ranges and weights. Loading only the default
    // space character would leave accented, Greek or Cyrillic task names falling back later.
    const faces = [...document.fonts].filter((face) => unquote(face.family) === family);
    if (!faces.length) throw new Error('Bundled font unavailable');
    await Promise.all(faces.map((face) => face.load()));
  })();
  fontLoads.set(id, loaded);
  try {
    await loaded;
  } catch (error) {
    fontLoads.delete(id);
    throw error;
  }
}

/** Default UI fallback and fixed brand/code face are ready before any text is painted. */
export async function loadBaseFonts(): Promise<void> {
  await Promise.all([loadFont('inter'), loadFont('jetbrains-mono')]);
}

/** Warm the font picker while Settings is open, without changing the current face. */
export function preloadFonts(): void {
  void Promise.allSettled(FONTS.map((font) => loadFont(font.id)));
}

const STORAGE_KEY = 'bokydo.appearance';
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Apply theme colours, font, size and density to the document (CSSOM only: CSP-safe). */
export async function applyAppearance(appearance: Appearance): Promise<void> {
  const revision = ++fontRevision;
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
  // Keep the current loaded face until ALL required weights are ready. A slower earlier
  // selection must never overwrite the user's latest choice.
  try {
    await loadFont(font.id);
    if (revision !== fontRevision) return;
    root.style.setProperty('--bk-font', font.stack);
  } catch {
    return; // Leave the current bundled font in place; a later selection can retry.
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...appearance, font: font.id }));
  } catch {
    // storage unavailable: fine, it's only to avoid a flash on next load
  }
}

/** The last appearance used on this device (applied before sign-in to avoid a flash). */
export function cachedAppearance(): Appearance | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = appearanceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Re-apply when the OS switches light/dark (for mode "system"). */
export function watchSystemMode(get: () => Appearance): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    void applyAppearance(get());
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
