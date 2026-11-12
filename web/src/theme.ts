// Light / Dark / System. "System" removes the attribute so index.css follows
// prefers-color-scheme; the choice is remembered per browser.
export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'avery.theme';

export function loadTheme(): ThemeChoice {
  try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; }
}

export function applyTheme(t: ThemeChoice): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { if (t === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* private mode */ }
}
