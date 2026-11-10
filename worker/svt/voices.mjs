/**
 * Picking a macOS `say` voice for a synthetic caller.
 *
 * `say -v '?'` lists installed voices, one per line:
 *   Rishi               en_IN    # Hello! My name is Rishi.
 *   Lekha               hi_IN    # नमस्ते! मेरा नाम लेखा है।
 *   Rishi (Enhanced)    en_IN    # …
 * Which ones exist depends on the macOS version and what the user
 * downloaded (System Settings → Accessibility → Spoken Content), so a
 * persona names the voices and locales it would like and gets the best one
 * installed, or a fallback with a note saying so — never a crash.
 */
import { spawnSync } from 'child_process';

/** [{ name, locale }] from `say -v '?'` output. */
export function parseSayVoices(output) {
  const voices = [];
  for (const line of String(output).split('\n')) {
    const m = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]{2,4})\s+#/.exec(line);
    if (m) voices.push({ name: m[1].trim(), locale: m[2].replace('-', '_') });
  }
  return voices;
}

/** Installed voices, or null when there is no `say` (not macOS). */
export function installedVoices() {
  const out = spawnSync('say', ['-v', '?'], { encoding: 'utf8' });
  if (out.error || out.status !== 0) return null;
  return parseSayVoices(out.stdout);
}

/**
 * The first installed voice among `prefer` (by name, "Rishi" also matching
 * "Rishi (Enhanced)"), then any voice in `locales`, then `fallback`.
 * Returns { voice, locale, note } — `note` explains a fallback.
 */
export function pickVoice(voices, { prefer = [], locales = [], fallback = [] }) {
  const base = (n) => n.replace(/\s*\(.*\)$/, '').toLowerCase();
  for (const want of prefer) {
    // Prefer the better-sounding Enhanced/Premium variant when both exist.
    const hits = voices.filter(v => base(v.name) === want.toLowerCase());
    const best = hits.find(v => /\((enhanced|premium)\)/i.test(v.name)) ?? hits[0];
    if (best) return { voice: best.name, locale: best.locale, note: null };
  }
  for (const loc of locales) {
    const v = voices.find(x => x.locale === loc);
    if (v) return { voice: v.name, locale: v.locale, note: `none of ${prefer.join('/')} installed; using ${v.name} (${loc})` };
  }
  for (const name of fallback) {
    const v = voices.find(x => base(x.name) === name.toLowerCase());
    if (v) {
      return { voice: v.name, locale: v.locale, note: `no ${locales.join('/') || 'preferred'} voice installed; falling back to ${v.name} (${v.locale})` };
    }
  }
  return { voice: null, locale: null, note: `no ${locales.join('/') || 'preferred'} voice installed; using the system default voice` };
}
