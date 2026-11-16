import { Hono } from 'hono';
import { withBusinessAccess, type HonoEnv } from '../middleware';
import { businessForShareToken, computeMetrics, getMetricsSettings, saveMetricsSettings, type PilotMetrics } from '../services/metrics';
import { getPilotConfig } from '../services/pilot';
import { getSector } from '../services/sector.service';

// /metrics/:businessType — the dashboard card (owner/staff), and the owner's
// switches for the weekly summary and the shareable report link.
// /report/:token — the read-only report the clinic opted in to share.

const DAY = 86_400;

/** Window: ?days=7|30|90 back from now, or the pilot's dates when ?pilot=1 and a pilot exists. */
async function window(c: any, businessType: string): Promise<{ from: number; to: number; label: string }> {
  const now = Math.floor(Date.now() / 1000);
  if (c.req.query('pilot') === '1') {
    const cfg = await getPilotConfig(c.env, businessType);
    if (cfg?.startsOn) {
      const from = Math.floor(Date.parse(`${cfg.startsOn}T00:00:00+05:30`) / 1000);
      const end = cfg.endsOn ? Math.floor(Date.parse(`${cfg.endsOn}T23:59:59+05:30`) / 1000) + 1 : now;
      return { from, to: Math.min(end, now), label: `Pilot ${cfg.startsOn} – ${cfg.endsOn ?? 'now'}` };
    }
  }
  const days = [7, 30, 90].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 30;
  return { from: now - days * DAY, to: now, label: `Last ${days} days` };
}

export const metricsRouter = new Hono<HonoEnv>();

metricsRouter.get('/:businessType', withBusinessAccess('staff'), async (c) => {
  const bt = c.req.param('businessType')!;
  const w = await window(c, bt);
  const s = await getMetricsSettings(c.env, bt);
  return c.json({ success: true, data: {
    window: w, metrics: await computeMetrics(c.env, bt, w.from, w.to),
    settings: { weeklySummary: s?.weeklySummary ?? false, shareEnabled: s?.shareEnabled ?? false, shareToken: s?.shareEnabled ? s.shareToken : null },
    hasPilot: !!(await getPilotConfig(c.env, bt))?.startsOn,
  } });
});

metricsRouter.put('/:businessType/settings', withBusinessAccess('owner'), async (c) => {
  const b = await c.req.json().catch(() => null) as any;
  const patch: { weeklySummary?: boolean; shareEnabled?: boolean } = {};
  if (typeof b?.weeklySummary === 'boolean') patch.weeklySummary = b.weeklySummary;
  if (typeof b?.shareEnabled === 'boolean') patch.shareEnabled = b.shareEnabled;
  const s = await saveMetricsSettings(c.env, c.req.param('businessType')!, patch);
  return c.json({ success: true, data: { weeklySummary: s.weeklySummary, shareEnabled: s.shareEnabled, shareToken: s.shareEnabled ? s.shareToken : null } });
});

export const publicReportRouter = new Hono<HonoEnv>();

const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)}%`);

export function renderReport(name: string, label: string, m: PilotMetrics): string {
  const row = (k: string, v: string, note: string) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td><td class="n">${esc(note)}</td></tr>`;
  const body = m.calls === 0
    ? '<p>No calls have reached the assistant in this period yet.</p>'
    : `<table>${[
      row('Calls handled', String(m.calls), 'Real calls that reached the assistant (test calls excluded)'),
      row('Answer rate', pct(m.answerRate), `${m.answered} calls where the caller spoke ÷ calls handled`),
      row('Overflow calls', String(m.overflowCalls), 'Forwarded from the clinic line when busy / unanswered'),
      row('After-hours calls', String(m.afterHoursCalls), 'Started outside the clinic\'s opening hours'),
      row('Recovered bookings', String(m.recoveredBookings), 'Bookings from overflow or after-hours calls'),
      row('Bookings from calls', String(m.bookingsFromCalls), 'All bookings made on or right after a call'),
      row('Transfer rate', pct(m.transferRate), `${m.transfers} transfers to staff ÷ answered calls`),
      row('No-show rate', m.noShow.status === 'ok' ? `${pct(m.noShow.before)} → ${pct(m.noShow.after)}` : 'Not tracked yet', 'Before vs during the pilot'),
    ].join('')}</table>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(name)}: assistant results</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#1d2433;background:#fff}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid #e3e6ec;vertical-align:top}
.n{color:#5b6475;font-size:13px}@media (prefers-color-scheme:dark){body{background:#12151c;color:#e6e9ef}th,td{border-color:#2a303c}.n{color:#9aa3b2}}</style></head>
<body><h1>${esc(name)}</h1><p>${esc(label)}. Figures come from real calls and bookings, updated live. Read-only.</p>${body}
<p class="n">Formulas: docs/pilot-metrics.md. Shared by the clinic; they can turn this link off at any time.</p></body></html>`;
}

publicReportRouter.get('/:token', async (c) => {
  const bt = await businessForShareToken(c.env, c.req.param('token'));
  if (!bt) return c.text('This report link is not active.', 404);
  const now = Math.floor(Date.now() / 1000);
  const cfg = await getPilotConfig(c.env, bt);
  let from = now - 30 * DAY, to = now, label = 'Last 30 days';
  if (cfg?.startsOn) {
    from = Math.floor(Date.parse(`${cfg.startsOn}T00:00:00+05:30`) / 1000);
    to = Math.min(now, cfg.endsOn ? Math.floor(Date.parse(`${cfg.endsOn}T23:59:59+05:30`) / 1000) + 1 : now);
    label = `Pilot ${cfg.startsOn} – ${cfg.endsOn ?? 'now'}`;
  }
  const m = await computeMetrics(c.env, bt, from, to);
  const name = (await getSector(c.env, bt))?.name ?? 'Clinic';
  if (c.req.query('format') === 'json') return c.json({ success: true, data: { name, label, metrics: m } });
  return c.html(renderReport(name, label, m), 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
});
