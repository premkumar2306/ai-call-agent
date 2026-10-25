import type { Env } from '../types';

// Admin UI origins. Both Pages project names are allowed because the
// project was renamed avery → mogi; extra origins (custom domains) come from
// the comma-separated ALLOWED_ORIGINS var. Auth is header-based (no cookies),
// so localhost stays allowed for local UI development against any API.
const PAGES_PROJECTS = ['mogi-admin', 'avery-admin'];

export function isAllowedOrigin(origin: string, env: Pick<Env, 'ALLOWED_ORIGINS'>): boolean {
  for (const project of PAGES_PROJECTS) {
    // Production origin, or a preview deployment (<hash>.<project>.pages.dev).
    if (origin === `https://${project}.pages.dev`) return true;
    if (origin.startsWith('https://') && origin.endsWith(`.${project}.pages.dev`)) return true;
  }
  const extra = (env.ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean);
  if (extra.includes(origin)) return true;
  return /^http:\/\/localhost:\d+$/.test(origin);
}
