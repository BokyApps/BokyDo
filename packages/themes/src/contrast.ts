/* eslint-disable @typescript-eslint/no-non-null-assertion --
   Index access below is bounds-checked by the surrounding loop/length conditions. */
/** WCAG 2.x contrast maths on #rrggbb colours. */

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * t) as [number, number, number]);
}

/**
 * Nudge `fg` toward black or white (whichever increases contrast) just enough to reach `min`
 * against every background. Colours that already pass are returned unchanged, so themes keep
 * their published palette wherever it is accessible.
 */
export function ensureContrast(fg: string, backgrounds: string[], min: number): string {
  const ok = (c: string) => backgrounds.every((bg) => contrast(c, bg) >= min);
  if (ok(fg)) return fg;
  const darkBg = backgrounds.reduce((s, bg) => s + luminance(bg), 0) / backgrounds.length < 0.4;
  const target = darkBg ? '#ffffff' : '#000000';
  for (let t = 0.02; t <= 1; t += 0.02) {
    const candidate = mix(fg, target, t);
    if (ok(candidate)) return candidate;
  }
  return target;
}

/** Black or white text, whichever reads better on `bg`. */
export function readableOn(bg: string, light = '#ffffff', dark = '#111111'): string {
  return contrast(light, bg) >= contrast(dark, bg) ? light : dark;
}
