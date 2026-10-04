/** Font choices (all SIL Open Font License; self-hosted, see NOTICE). */
export const FONTS = [
  {
    id: 'system',
    name: 'System',
    stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif',
  },
  { id: 'inter', name: 'Inter', stack: '"Inter Variable", system-ui, sans-serif' },
  { id: 'ibm-plex-sans', name: 'IBM Plex Sans', stack: '"IBM Plex Sans", system-ui, sans-serif' },
  {
    id: 'atkinson',
    name: 'Atkinson Hyperlegible',
    stack: '"Atkinson Hyperlegible", system-ui, sans-serif',
  },
  { id: 'lexend', name: 'Lexend', stack: '"Lexend Variable", system-ui, sans-serif' },
  { id: 'opendyslexic', name: 'OpenDyslexic', stack: '"OpenDyslexic", system-ui, sans-serif' },
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    stack: '"JetBrains Mono Variable", ui-monospace, monospace',
  },
  { id: 'fira-code', name: 'Fira Code', stack: '"Fira Code Variable", ui-monospace, monospace' },
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
