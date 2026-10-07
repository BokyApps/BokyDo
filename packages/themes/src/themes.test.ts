import { describe, expect, it } from 'vitest';
import { contrast, ensureContrast, mix } from './contrast.js';
import { FAMILIES, VARIANTS } from './palettes.js';
import { THEMES, TINTS } from './tokens.js';

describe('theme catalogue', () => {
  it('has the ten terminal families plus BokyDo, each with a light and a dark default', () => {
    expect(FAMILIES.map((f) => f.id)).toEqual([
      'bokydo',
      'catppuccin',
      'gruvbox',
      'dracula',
      'nord',
      'tokyonight',
      'solarized',
      'one',
      'rosepine',
      'everforest',
      'kanagawa',
    ]);
    for (const f of FAMILIES) {
      expect(VARIANTS.find((v) => v.id === f.defaultLight)?.mode, f.id).toBe('light');
      expect(VARIANTS.find((v) => v.id === f.defaultDark)?.mode, f.id).toBe('dark');
    }
    expect(new Set(VARIANTS.map((v) => v.id)).size).toBe(VARIANTS.length);
  });
});

/** WCAG 2.2 AA for every variant: 4.5:1 text, 3:1 UI, against background, surface and hover. */
describe.each(THEMES.map((t) => [t.id, t] as const))('%s meets WCAG AA', (_id, theme) => {
  const t = theme.tokens;
  const backgrounds = [t.bg, t.surface, t.surfaceAlt];
  const atLeast = (fg: string, min: number, bgs = backgrounds) =>
    bgs.every((bg) => contrast(fg, bg) >= min);

  it('text and muted text ≥ 4.5:1', () => {
    expect(atLeast(t.fg, 4.5)).toBe(true);
    expect(atLeast(t.muted, 4.5)).toBe(true);
    expect(atLeast(t.danger, 4.5)).toBe(true);
  });
  it('colours used as text (due labels, flags, errors) ≥ 4.5:1', () => {
    for (const [name, c] of Object.entries({
      danger: t.danger,
      warning: t.warning,
      success: t.success,
      p1: t.p1,
      p2: t.p2,
      p3: t.p3,
    }))
      expect(atLeast(c, 4.5), `${name} ${c}`).toBe(true);
  });
  it('accent text (links) ≥ 4.5:1, and a button label ≥ 4.5:1 on the accent', () => {
    expect(atLeast(t.accent, 4.5)).toBe(true);
    expect(contrast(t.accentFg, t.accent)).toBeGreaterThanOrEqual(4.5);
  });
  it('coloured text also reads on a tint of its own colour (badges, selected rows)', () => {
    for (const [name, alphas] of Object.entries(TINTS) as [keyof typeof TINTS, number[]][])
      for (const bg of backgrounds)
        for (const a of alphas)
          expect(
            contrast(t[name], mix(bg, t[name], a)),
            `${name} on ${a} tint`,
          ).toBeGreaterThanOrEqual(4.5);
  });
  it('priority flags and project colours ≥ 3:1', () => {
    for (const c of [t.p1, t.p2, t.p3, t.p4, t.warning, t.success, ...Object.values(t.project)]) {
      expect(atLeast(c, 3), c).toBe(true);
    }
  });
  it('p1–p3 are distinguishable from each other', () => {
    expect(new Set([t.p1, t.p2, t.p3]).size).toBe(3);
  });
});

describe('ensureContrast', () => {
  it('leaves passing colours untouched and fixes failing ones minimally', () => {
    expect(ensureContrast('#000000', ['#ffffff'], 4.5)).toBe('#000000');
    const fixed = ensureContrast('#ffcc00', ['#ffffff'], 3);
    expect(contrast(fixed, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(fixed).not.toBe('#000000');
  });
});

describe('fidelity', () => {
  it('keeps most published colours exactly (adjustments are the exception)', () => {
    let kept = 0;
    let total = 0;
    for (const def of VARIANTS) {
      const theme = THEMES.find((t) => t.id === def.id)!;
      for (const key of ['fg', 'muted', 'accent'] as const) {
        total++;
        if (theme.tokens[key] === def.raw[key]) kept++;
      }
    }
    // Accents are link text, so more of them are nudged to 4.5:1 than were at the old 3:1.
    expect(kept / total).toBeGreaterThan(0.6);
  });
});
