import { useState, useEffect } from 'react';

interface Props {
  sector: string;
  base: string;
}

interface TranscriptRow {
  id: string;
  callSid: string | null;
  customerIdHashed: string;
  businessType: string;
  turns: Array<{ role: string; content: string }>;
  createdAt: number | string;
}

const ADMIN_KEY = import.meta.env.VITE_ADMIN_KEY ?? '';
const API_URL   = import.meta.env.VITE_API_URL ?? '';

const POLICY_RULES = [
  { rule: 'Opt-in only — only reply to users who message first',                                        status: '✅', note: 'Enforced (webhook-reply model)' },
  { rule: '24-hour service window — free-form only within 24 h of user\'s last message',               status: '✅', note: 'KV TTL = 24 h' },
  { rule: 'AI disclosure — must say "yes I\'m an AI" if asked',                                         status: '✅', note: 'In system prompt' },
  { rule: 'Opt-out — STOP / Unsubscribe must end messaging',                                            status: '✅', note: 'Checked before agentic loop' },
  { rule: 'No prohibited content — no spam, illegal offers, deception',                                 status: '✅', note: 'System prompt guards' },
  { rule: 'Data minimisation — phone numbers are hashed before storage',                                status: '✅', note: 'HMAC-SHA256' },
  { rule: 'Business verification — need verified Meta Business Account',                                status: '⚠️', note: 'Manual setup required' },
  { rule: 'Rate limits — Meta enforces per-number limits',                                              status: '✅', note: 'Local 20 msg/60 s cap' },
  { rule: 'Template messages — proactive outbound needs pre-approved templates',                         status: 'ℹ️', note: 'Not implemented (inbound-only)' },
  { rule: 'GDPR / right to delete — customer data must be deletable on request',                        status: '⚠️', note: 'Implement before regulated-market launch' },
];

function relativeTime(ts: number | string): string {
  const ms = typeof ts === 'number' ? ts * 1000 : new Date(ts).getTime();
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const card: React.CSSProperties = {
  background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 14, padding: 28,
};
const h2: React.CSSProperties = {
  fontSize: 16, fontWeight: 600, color: '#fff', marginBottom: 20, marginTop: 0,
};
const label: React.CSSProperties = {
  fontSize: 12, color: '#888', marginBottom: 4, display: 'block',
};
const codeBox: React.CSSProperties = {
  background: '#1a1a2e', border: '1px solid #2a2a3a', borderRadius: 8,
  padding: '10px 14px', color: '#a78bff', fontFamily: 'monospace', fontSize: 13,
  wordBreak: 'break-all',
};
const copyBtn: React.CSSProperties = {
  marginLeft: 10, padding: '4px 12px', borderRadius: 6, border: '1px solid #6c47ff',
  background: 'transparent', color: '#a78bff', cursor: 'pointer', fontSize: 12,
};
const stepItem: React.CSSProperties = {
  fontSize: 14, color: '#ccc', lineHeight: 1.8,
};

export default function WhatsApp({ sector, base }: Props) {
  const [transcripts, setTranscripts]     = useState<TranscriptRow[]>([]);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState('');
  const [expanded, setExpanded]           = useState<Record<string, boolean>>({});
  const [copied, setCopied]               = useState(false);

  const webhookUrl = `${API_URL}/whatsapp/webhook`;

  useEffect(() => {
    if (!sector) return;
    setLoading(true);
    setError('');
    fetch(`${base}/admin/transcripts/${sector}?channel=wa`, {
      headers: { 'X-Admin-Key': ADMIN_KEY },
    })
      .then(r => r.json())
      .then((json: any) => {
        if (json.success) setTranscripts(json.data ?? []);
        else setError(json.error ?? 'Failed to load transcripts');
      })
      .catch(() => setError('Network error loading transcripts'))
      .finally(() => setLoading(false));
  }, [sector, base]);

  function copyWebhook() {
    navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function toggleExpand(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div style={{ display: 'grid', gap: 24 }}>

      {/* ── Section 1: Setup Instructions ── */}
      <div style={card}>
        <h2 style={h2}>WhatsApp Cloud API Setup</h2>

        <div style={{ display: 'grid', gap: 20 }}>
          {/* Webhook URL */}
          <div>
            <span style={label}>Webhook URL (register this in Meta for Developers)</span>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ ...codeBox, flex: 1 }}>{webhookUrl}</div>
              <button style={copyBtn} onClick={copyWebhook}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Verify Token */}
          <div>
            <span style={label}>Verify Token</span>
            <div style={codeBox}>
              <span style={{ color: '#888' }}>{'<value of WA_VERIFY_TOKEN secret>'}</span>
              <span style={{ fontSize: 12, color: '#666', marginLeft: 12 }}>
                Set via: <code>wrangler secret put WA_VERIFY_TOKEN</code>
              </span>
            </div>
          </div>

          {/* Step-by-step */}
          <div>
            <span style={label}>Setup checklist</span>
            <ol style={{ paddingLeft: 20, margin: 0, display: 'grid', gap: 6 }}>
              {[
                'Create / verify a Meta Business Account at business.facebook.com',
                'In Meta for Developers, create an App → add the WhatsApp product',
                'Add a phone number → note the WA_PHONE_NUMBER_ID shown',
                'Generate a permanent system user token with whatsapp_business_messaging scope → WA_ACCESS_TOKEN',
                'Choose any string as your verify token → WA_VERIFY_TOKEN',
                'Register the webhook above with the Callback URL and Verify Token',
                'Subscribe to the messages field under webhook fields',
                'Run: wrangler secret put WA_PHONE_NUMBER_ID  (and WA_ACCESS_TOKEN, WA_VERIFY_TOKEN, WA_APP_SECRET)',
                'Deploy: cd worker && wrangler deploy',
              ].map((step, i) => (
                <li key={i} style={stepItem}>{step}</li>
              ))}
            </ol>
          </div>

          {/* Click-to-chat */}
          <div>
            <span style={label}>Click-to-chat link (once phone number is configured)</span>
            <a
              href="https://wa.me/1YOURNUMBER?text=Hi"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                background: '#25d366', color: '#fff', padding: '10px 20px',
                borderRadius: 10, textDecoration: 'none', fontWeight: 600, fontSize: 14,
              }}
            >
              <span style={{ fontSize: 20 }}>💬</span>
              Open on WhatsApp (replace YOURNUMBER)
            </a>
          </div>
        </div>
      </div>

      {/* ── Section 2: Transcripts ── */}
      <div style={card}>
        <h2 style={h2}>WhatsApp Transcripts — {sector}</h2>

        {loading && <p style={{ color: '#888', fontSize: 14 }}>Loading…</p>}
        {error   && <p style={{ color: '#f87171', fontSize: 14 }}>{error}</p>}

        {!loading && !error && transcripts.length === 0 && (
          <p style={{ color: '#888', fontSize: 14 }}>
            No WhatsApp conversations yet for this business.
          </p>
        )}

        <div style={{ display: 'grid', gap: 12 }}>
          {transcripts.map(t => {
            const anonId   = t.customerIdHashed.slice(-8);
            const lastTurn = [...t.turns].reverse().find(x => x.role === 'assistant');
            const preview  = lastTurn ? lastTurn.content.slice(0, 80) + (lastTurn.content.length > 80 ? '…' : '') : '—';
            const isOpen   = expanded[t.id];

            return (
              <div key={t.id} style={{ background: '#1a1a2e', borderRadius: 10, border: '1px solid #2a2a3a', overflow: 'hidden' }}>
                <div
                  style={{ padding: '14px 18px', cursor: 'pointer', display: 'flex', gap: 16, alignItems: 'center' }}
                  onClick={() => toggleExpand(t.id)}
                >
                  <span style={{ fontSize: 12, color: '#888', minWidth: 80 }}>
                    {relativeTime(t.createdAt)}
                  </span>
                  <span style={{ fontSize: 12, color: '#6c47ff', fontFamily: 'monospace' }}>
                    …{anonId}
                  </span>
                  <span style={{ fontSize: 12, color: '#888' }}>
                    {t.turns.length} turns
                  </span>
                  <span style={{ fontSize: 13, color: '#ccc', flex: 1 }}>{preview}</span>
                  <span style={{ color: '#888', fontSize: 12 }}>{isOpen ? '▲' : '▼'}</span>
                </div>

                {isOpen && (
                  <div style={{ borderTop: '1px solid #2a2a3a', padding: '14px 18px', display: 'grid', gap: 8 }}>
                    {t.turns.map((turn, i) => (
                      <div key={i} style={{
                        padding: '8px 12px', borderRadius: 8,
                        background: turn.role === 'user' ? '#12121a' : '#1e1e30',
                        borderLeft: `3px solid ${turn.role === 'user' ? '#6c47ff' : '#25d366'}`,
                      }}>
                        <span style={{ fontSize: 11, color: '#888', marginBottom: 4, display: 'block' }}>
                          {turn.role === 'user' ? 'Customer' : 'Avery'}
                        </span>
                        <span style={{ fontSize: 13, color: '#ddd' }}>{turn.content}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Section 3: Policy Compliance ── */}
      <div style={card}>
        <h2 style={h2}>WhatsApp AI Messaging Policy — Required Compliance</h2>
        <p style={{ fontSize: 13, color: '#888', marginTop: -12, marginBottom: 20 }}>
          Based on Meta WhatsApp Business Policy (business.whatsapp.com/policy)
        </p>

        <div style={{ display: 'grid', gap: 10 }}>
          {POLICY_RULES.map((r, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '28px 1fr auto',
              gap: 12, alignItems: 'start',
              background: '#1a1a2e', borderRadius: 8, padding: '12px 16px',
              border: '1px solid #2a2a3a',
            }}>
              <span style={{ fontWeight: 700, color: '#a78bff', fontSize: 14 }}>{i + 1}</span>
              <span style={{ fontSize: 13, color: '#ccc', lineHeight: 1.5 }}>{r.rule}</span>
              <span style={{ fontSize: 12, color: '#888', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {r.status} {r.note}
              </span>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
