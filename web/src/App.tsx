import { useState, useEffect } from 'react';
import Dashboard from './pages/Dashboard';
import VoiceTest from './pages/VoiceTest';

const TABS = ['Customize', 'Voice Test', 'Overview'] as const;
type Tab = typeof TABS[number];

const BASE = import.meta.env.VITE_API_URL ?? '';

interface SectorOption { key: string; name: string }

export default function App() {
  const [tab, setTab] = useState<Tab>('Voice Test');
  const [sector, setSector] = useState<string>('');
  const [sectors, setSectors] = useState<SectorOption[]>([]);

  useEffect(() => {
    fetch(`${BASE}/sectors`)
      .then(r => r.json())
      .then(json => {
        if (json.success && json.data.length) {
          setSectors(json.data);
          setSector(json.data[0].key);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen" style={{ background: '#0a0a0f', color: '#e0e0e0', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* Header */}
      <header style={{ background: '#12121a', borderBottom: '1px solid #222', padding: '16px 32px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#fff', margin: 0 }}>Avery</h1>
        <span style={{ background: '#6c47ff22', color: '#a78bff', padding: '2px 10px', borderRadius: 99, fontSize: 12, border: '1px solid #6c47ff44' }}>
          Client Dashboard
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#888' }}>Business</label>
          <select
            value={sector}
            onChange={e => setSector(e.target.value)}
            style={{ background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '6px 12px', borderRadius: 8, outline: 'none', minWidth: 180 }}
          >
            {sectors.map(s => (
              <option key={s.key} value={s.key}>{s.name}</option>
            ))}
          </select>
        </div>
      </header>

      <main style={{ maxWidth: 900, margin: '40px auto', padding: '0 24px', display: 'grid', gap: 24 }}>
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, background: '#12121a', padding: 4, borderRadius: 10, width: 'fit-content' }}>
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '8px 20px', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 500,
                border: 'none', transition: 'all .15s',
                background: tab === t ? '#6c47ff' : 'transparent',
                color: tab === t ? '#fff' : '#888',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'Customize' && <Dashboard sector={sector} base={BASE} />}
        {tab === 'Voice Test' && <VoiceTest sector={sector} base={BASE} />}
        {tab === 'Overview' && <Overview />}
      </main>
    </div>
  );
}

function Overview() {
  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <div style={{ background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 14, padding: 28 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginBottom: 20 }}>Quick Stats</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {[['2', 'Active Sectors'], ['9', 'Voice Tools'], ['200', 'Max Tokens / Turn']].map(([v, k]) => (
            <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 28, fontWeight: 700, color: '#fff' }}>{v}</span>
              <span style={{ fontSize: 13, color: '#888' }}>{k}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 14, padding: 28 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginBottom: 12 }}>Twilio Setup</h2>
        <p style={{ fontSize: 14, color: '#888', lineHeight: 1.7 }}>
          Point your Twilio Voice webhook to:<br />
          <code style={{ color: '#a78bff', background: '#1a1a2e', padding: '2px 6px', borderRadius: 4 }}>
            {'POST https://<your-worker>.workers.dev/twilio/inbound?token=<jwt>'}
          </code>
          <br /><br />
          Each turn: Twilio STT →{' '}
          <code style={{ color: '#a78bff', background: '#1a1a2e', padding: '2px 6px', borderRadius: 4 }}>
            POST /twilio/turn
          </code>{' '}
          → Claude Haiku (200 tokens) → TwiML → Twilio TTS
        </p>
      </div>
    </div>
  );
}
