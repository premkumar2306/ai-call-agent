import { useState, useEffect, useCallback } from 'react';

interface SectorConfig {
  storeName: string;
  greeting: string;
  agentName: string;
  primaryColor: string;
  supportEmail: string;
  maxRecommendations: number;
}

interface Props {
  sector: string;
  base: string;
}

function Toast({ msg, type, onClear }: { msg: string; type: 'ok' | 'error' | ''; onClear: () => void }) {
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(onClear, 3000);
    return () => clearTimeout(t);
  }, [msg, onClear]);

  if (!msg) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, padding: '12px 20px', borderRadius: 8,
      fontSize: 14, fontWeight: 600, color: '#fff',
      background: type === 'error' ? '#ef4444' : '#22c55e',
    }}>
      {msg}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#0a0a0f', border: '1px solid #2a2a3a', borderRadius: 8,
  color: '#fff', padding: '10px 14px', fontSize: 14, outline: 'none', boxSizing: 'border-box',
};

const ADMIN_KEY = import.meta.env.VITE_ADMIN_KEY ?? '';

export default function Dashboard({ sector, base }: Props) {
  const [cfg, setCfg] = useState<SectorConfig>({
    storeName: '', greeting: '', agentName: 'Avery',
    primaryColor: '#6c47ff', supportEmail: '', maxRecommendations: 3,
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'error' | '' }>({ msg: '', type: '' });

  const showToast = (msg: string, type: 'ok' | 'error' = 'ok') => setToast({ msg, type });

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch(`${base}/admin/config/${sector}`);
      const json = await res.json();
      if (json.success) setCfg(json.data);
    } catch {
      showToast('Failed to load config', 'error');
    }
  }, [sector, base]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${base}/admin/config/${sector}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify(cfg),
      });
      if (res.ok) showToast('Saved!');
      else showToast('Save failed', 'error');
    } catch {
      showToast('Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const set = (field: keyof SectorConfig) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setCfg(prev => ({ ...prev, [field]: field === 'maxRecommendations' ? parseInt((e.target as HTMLInputElement).value) || 3 : e.target.value }));

  return (
    <>
      <div style={{ background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 14, padding: 28 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginBottom: 20 }}>Store Settings</h2>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: '#888', marginBottom: 6 }}>Store Name</label>
            <input style={inputStyle} value={cfg.storeName} onChange={set('storeName')} placeholder="AutoStore" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: '#888', marginBottom: 6 }}>Agent Name</label>
            <input style={inputStyle} value={cfg.agentName} onChange={set('agentName')} placeholder="Avery" />
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={{ display: 'block', fontSize: 13, color: '#888', marginBottom: 6 }}>Opening Greeting</label>
          <textarea
            style={{ ...inputStyle, resize: 'vertical', minHeight: 80, fontFamily: 'inherit' }}
            value={cfg.greeting}
            onChange={set('greeting')}
            placeholder="Welcome! How can I help you today?"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: '#888', marginBottom: 6 }}>Support Email</label>
            <input style={inputStyle} type="email" value={cfg.supportEmail} onChange={set('supportEmail')} placeholder="support@yourstore.com" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: '#888', marginBottom: 6 }}>Max Recommendations</label>
            <input style={inputStyle} type="number" min={1} max={10} value={cfg.maxRecommendations}
              onChange={set('maxRecommendations')} />
          </div>
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', fontSize: 13, color: '#888', marginBottom: 6 }}>Primary Color</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="color" value={cfg.primaryColor}
              onChange={e => setCfg(prev => ({ ...prev, primaryColor: e.target.value }))}
              style={{ width: 44, height: 36, border: 'none', padding: 0, background: 'none', cursor: 'pointer', borderRadius: 6 }}
            />
            <input style={{ ...inputStyle, width: 120 }} value={cfg.primaryColor}
              onChange={e => {
                if (/^#[0-9a-fA-F]{6}$/.test(e.target.value))
                  setCfg(prev => ({ ...prev, primaryColor: e.target.value }));
              }}
            />
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            background: '#6c47ff', color: '#fff', border: 'none', borderRadius: 8,
            padding: '10px 24px', fontSize: 14, fontWeight: 600, cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.4 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      <Toast msg={toast.msg} type={toast.type} onClear={() => setToast({ msg: '', type: '' })} />
    </>
  );
}
