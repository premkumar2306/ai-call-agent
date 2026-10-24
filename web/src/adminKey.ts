// The admin key is entered by the operator at runtime and kept in
// sessionStorage (cleared when the tab closes). It must never be a VITE_*
// variable: anything in import.meta.env is compiled into the public bundle.
const STORAGE_KEY = 'mogi.adminKey';

export function loadAdminKey(): string {
  try { return sessionStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
}

export function saveAdminKey(key: string): void {
  try {
    if (key) sessionStorage.setItem(STORAGE_KEY, key);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* storage unavailable (private mode) — key lives in memory only */ }
}
