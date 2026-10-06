/**
 * format.ts
 * =========
 *
 * Small, dependency-free formatters shared by the History list and the job
 * detail screen. Kept pure so they are trivial to unit test.
 */

/** `517 KB`, `1.42 MB` — never a bare byte count in the UI. */
export function formatBytes(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** `420 ms`, `9.3 s`, `3m 05s`. */
export function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

/** `2:22` — clock style, for audio length and player position. */
export function formatClock(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * `2h ago`, `Yesterday`, `Sep 8` — the relative phrasing the History list uses.
 *
 * @param epochSeconds server timestamp (seconds since the epoch)
 * @param now injectable for deterministic tests
 */
export function formatRelative(epochSeconds: number, now: number = Date.now()): string {
  const deltaMs = now - epochSeconds * 1000;
  const minutes = Math.floor(deltaMs / 60000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return 'Yesterday';

  const date = new Date(epochSeconds * 1000);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const month = date.toLocaleString('en-US', { month: 'short' });
  return sameYear ? `${month} ${date.getDate()}` : `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

/** Strip the extension for display, keeping the user's own naming. */
export function displayName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}
