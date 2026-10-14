// One set of visual constants for the HTML interface and the canvas renderer, so that a change here
// moves both: the stylesheet reads them as CSS custom properties (applyThemeCss), the renderer as
// numbers (hex). Calm by default — charcoal for the one primary action, navy for links and active
// state, the familiar blue only for the selection on the grid, amber and red only with words.

export const THEME = {
  font: 'Inter, "Segoe UI", Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  colors: {
    canvas: '#f3f4f6',
    panel: '#ffffff',
    border: '#e5e7eb',
    borderStrong: '#9ca3af',
    text: '#111827',
    muted: '#5f5e5a',
    /** links, active state, trace precedents */
    accent: '#0c447c',
    accentSoft: '#e4edf7',
    /** the one filled button */
    primary: '#1f2937',
    primaryHover: '#111827',
    quiet: '#f3f4f6',
    quietHover: '#e9eaee',
    danger: '#b91c1c',
    /** warnings that must read on white: 5.9:1 on #fafafa */
    amber: '#8a5200',
    amberSoft: '#fdf1d6',
    green: '#2e7d32',
    greenSoft: '#dcfce7',
    /** grid */
    selection: '#2563eb',
    selectionSoft: '#3b82f6',
    headerBg: '#f1f5f9',
    grid: '#e5e7eb',
    spill: '#60a5fa',
    traceOut: '#993c1d',
    merge: '#cbd5e1',
    tab: '#e5e7eb',
    tabText: '#4b5563',
  },
  /** grid text sizes by density */
  gridFont: { comfortable: 13, compact: 12 } as const,
  /** interface text sizes (px) */
  ui: { base: 14, small: 12.5, title: 17, section: 12 },
};

export const hex = (css: string) => parseInt(css.replace('#', ''), 16);

/** Expose the theme to the stylesheet as --c-<name> custom properties. */
export function applyThemeCss() {
  const r = document.documentElement.style;
  for (const [k, v] of Object.entries(THEME.colors)) r.setProperty(`--c-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`, v);
  r.setProperty('--font', THEME.font);
  r.setProperty('--mono', THEME.mono);
  r.setProperty('--ui-base', `${THEME.ui.base}px`);
  r.setProperty('--ui-small', `${THEME.ui.small}px`);
  r.setProperty('--ui-title', `${THEME.ui.title}px`);
  r.setProperty('--ui-section', `${THEME.ui.section}px`);
}
