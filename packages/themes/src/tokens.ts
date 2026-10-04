import { contrast, ensureContrast, readableOn } from './contrast.js';
import { FAMILIES, PROJECT_COLORS, VARIANTS, type Mode, type VariantDef } from './palettes.js';

/** Semantic colour tokens consumed by the web app (CSS variables) and Android (Compose). */
export interface ThemeTokens {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  fg: string;
  muted: string;
  accent: string;
  accentFg: string;
  danger: string;
  warning: string;
  success: string;
  p1: string;
  p2: string;
  p3: string;
  p4: string;
  /** Project/label colours tuned to stay visible on this theme. */
  project: Record<string, string>;
}

export interface Theme {
  id: string;
  family: string;
  name: string;
  mode: Mode;
  tokens: ThemeTokens;
}

const TEXT = 4.5; // WCAG AA body text
const UI = 3; // WCAG AA non-text UI (icons, flags, focus, borders of controls)

/**
 * Derive accessible tokens from a raw palette. Text colours must reach 4.5:1 and UI colours 3:1
 * against both the background and the surface; anything that already passes keeps its exact
 * published colour.
 */
export function deriveTokens(def: VariantDef): ThemeTokens {
  const r = def.raw;
  const bgs = [r.bg, r.surface, r.surfaceAlt];
  let accent = ensureContrast(r.accent, [r.bg, r.surface], UI);
  let accentFg = readableOn(accent, '#ffffff', def.mode === 'dark' ? r.bg : '#111111');
  if (contrast(accentFg, accent) < TEXT) {
    // Neither white nor dark text reads well on this accent (e.g. Solarized blue): keep the
    // theme's own text colour and move the accent away from it until button text is readable.
    accentFg = def.mode === 'dark' ? r.bg : '#ffffff';
    accent = ensureContrast(accent, [accentFg], TEXT);
  }
  return {
    bg: r.bg,
    surface: r.surface,
    surfaceAlt: r.surfaceAlt,
    border: r.border,
    fg: ensureContrast(r.fg, bgs, TEXT),
    muted: ensureContrast(r.muted, bgs, TEXT),
    accent,
    accentFg,
    danger: ensureContrast(r.red, bgs, TEXT),
    warning: ensureContrast(r.orange, bgs, UI),
    success: ensureContrast(r.green, bgs, UI),
    p1: ensureContrast(r.red, bgs, UI),
    p2: ensureContrast(r.orange, bgs, UI),
    p3: ensureContrast(r.blue, bgs, UI),
    p4: ensureContrast(r.muted, bgs, UI),
    project: Object.fromEntries(
      Object.entries(PROJECT_COLORS).map(([k, hex]) => [k, ensureContrast(hex, bgs, UI)]),
    ),
  };
}

export const THEMES: Theme[] = VARIANTS.map((def) => ({
  id: def.id,
  family: def.family,
  name: def.name,
  mode: def.mode,
  tokens: deriveTokens(def),
}));

const byId = new Map(THEMES.map((t) => [t.id, t]));
export const THEME_IDS = THEMES.map((t) => t.id);

export function getTheme(id: string, fallbackMode: Mode = 'light'): Theme {
  const theme = byId.get(id) ?? byId.get(fallbackMode === 'dark' ? 'bokydo-dark' : 'bokydo-light');
  if (!theme) throw new Error('BokyDo default themes missing');
  return theme;
}

export { FAMILIES, PROJECT_COLORS };

/** CSS custom properties for a theme (applied to :root by the web app). */
export function cssVariables(theme: Theme): Record<string, string> {
  const t = theme.tokens;
  const vars: Record<string, string> = {
    '--bk-bg': t.bg,
    '--bk-surface': t.surface,
    '--bk-surface-alt': t.surfaceAlt,
    '--bk-border': t.border,
    '--bk-fg': t.fg,
    '--bk-muted': t.muted,
    '--bk-accent': t.accent,
    '--bk-accent-fg': t.accentFg,
    '--bk-danger': t.danger,
    '--bk-warning': t.warning,
    '--bk-success': t.success,
    '--bk-p1': t.p1,
    '--bk-p2': t.p2,
    '--bk-p3': t.p3,
    '--bk-p4': t.p4,
  };
  for (const [name, hex] of Object.entries(t.project))
    vars[`--bk-project-${name.replace(/_/g, '-')}`] = hex;
  return vars;
}
