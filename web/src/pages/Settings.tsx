import { useEffect, useState } from 'react';

interface Props {
  base: string;
  adminKey: string;
  sectors: { key: string; name: string }[];
}

interface State { selected: string | null; effective: string | null; envDefault: string | null }

const card: React.CSSProperties = { background: '#12121a', border: '1px solid #222', borderRadius: 12, padding: 20 };

export default function Settings({ base, adminKey, sectors }: Props) {
  const [state, setState] = useState<State | null>(null);
  const [choice, setChoice] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const nameOf = (key: string | null) => sectors.find(s => s.key === key)?.name ?? key ?? '—';

  const load = async () => {
    try {
      const res = await fetch(`${base}/admin/default-business`, { headers: { 'X-Admin-Key': adminKey } });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to load');
      setState(json.data);
      setChoice(json.data.effective ?? '');
    } catch (e: any) {
      setState(null);
      setMsg({ text: e.message === 'Admin key required' ? 'Enter the admin key (top right) to manage this.' : e.message, ok: false });
    }
  };

  useEffect(() => { setMsg(null); if (adminKey) load(); else setMsg({ text: 'Enter the admin key (top right) to manage this.', ok: false }); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adminKey, base]);

  const save = async (businessType: string | null) => {
    setSaving(true); setMsg(null);
    try {
      const res = await fetch(`${base}/admin/default-business`, {
        method: 'PUT',
        headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessType }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Save failed');
      setMsg({ text: businessType ? `Calls now answered as ${nameOf(businessType)}.` : 'Reverted to the deployed default.', ok: true });
      await load();
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: '#fff' }}>Phone line</h2>
      <p style={{ margin: '0 0 16px', color: '#888', fontSize: 13 }}>
        Which business answers inbound calls (and WhatsApp messages without a number-specific mapping). Takes effect on the next call.
      </p>
      {state && (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#aaa' }}>
          Currently answering as <b style={{ color: '#fff' }}>{nameOf(state.effective)}</b>
          {state.selected ? '' : ' (deployed default)'}
        </p>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={choice}
          onChange={e => setChoice(e.target.value)}
          disabled={!state}
          style={{ background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '8px 12px', borderRadius: 8, minWidth: 220 }}
        >
          {!choice && <option value="">Select a business…</option>}
          {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <button
          onClick={() => save(choice)}
          disabled={!state || !choice || saving || choice === state.effective}
          style={{ background: '#6c47ff', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8, cursor: 'pointer', opacity: !state || !choice || saving || choice === state.effective ? 0.5 : 1 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {state?.selected && (
          <button
            onClick={() => save(null)}
            disabled={saving}
            style={{ background: 'transparent', color: '#a78bff', border: '1px solid #6c47ff66', padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}
          >
            Revert to default ({nameOf(state.envDefault)})
          </button>
        )}
      </div>
      {msg && <p style={{ margin: '12px 0 0', fontSize: 13, color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</p>}
    </div>
  );
}
