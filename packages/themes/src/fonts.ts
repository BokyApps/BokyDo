/** Font choices (all SIL Open Font License; self-hosted, see NOTICE). */
export const FONTS = [
  { id: 'inter', name: 'Inter', stack: '"Inter Variable"' },
  { id: 'ibm-plex-sans', name: 'IBM Plex Sans', stack: '"IBM Plex Sans", "Inter Variable"' },
  {
    id: 'atkinson',
    name: 'Atkinson Hyperlegible',
    stack: '"Atkinson Hyperlegible", "Inter Variable"',
  },
  { id: 'lexend', name: 'Lexend', stack: '"Lexend Variable", "Inter Variable"' },
  { id: 'opendyslexic', name: 'OpenDyslexic', stack: '"OpenDyslexic", "Inter Variable"' },
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    stack: '"JetBrains Mono Variable", "Inter Variable"',
  },
  { id: 'fira-code', name: 'Fira Code', stack: '"Fira Code Variable", "Inter Variable"' },
] as const;

export type FontId = (typeof FONTS)[number]['id'];
export const FONT_IDS = FONTS.map((f) => f.id) as [FontId, ...FontId[]];

export const TEXT_SIZES = {
  small: '14px',
  default: '16px',
  large: '18px',
  larger: '20px',
} as const;
export type TextSize = keyof typeof TEXT_SIZES;
