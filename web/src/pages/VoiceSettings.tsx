import { useEffect, useState } from 'react';

interface Props {
  base: string;
  adminKey: string;
  sectors: { key: string; name: string }[];
}

interface Voice {
  language: 'en' | 'hi' | 'hi-en';
  sttProvider: 'deepgram' | 'sarvam';
  ttsProvider: 'cartesia' | 'sarvam';
  voiceId?: string;
  sarvamConfigured?: boolean;
}

const card: React.CSSProperties = { background: '#12121a', border: '1px solid #222', borderRadius: 12, padding: 20 };
const select: React.CSSProperties = { background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '8px 12px', borderRadius: 8, minWidth: 200 };
const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#888' };

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'hi-en', label: 'Hinglish (Hindi + English)' },
];

// Per-business phone-line language and speech providers (PUT /admin/sectors/:key/voice).
export default function VoiceSettings({ base, adminKey, sectors }: Props) {
  const [business, setBusiness] = useState('');
  const [voice, setVoice] = useState<Voice | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!business && sectors.length) setBusiness(sectors[0].key); }, [sectors, business]);

  useEffect(() => {
    setVoice(null); setMsg(null);
    if (!adminKey || !business) return;
    fetch(`${base}/admin/sectors/${encodeURIComponent(business)}/voice`, { headers: { 'X-Admin-Key': adminKey } })
      .then(r => r.json())
      .then(json => {
        if (!json.success) throw new Error(json.error ?? 'Failed to load');
        setVoice(json.data);
      })
      .catch((e: any) => setMsg({ text: e.message === 'Admin key required' ? 'Enter the admin key (top right) to manage this.' : e.message, ok: false }));
  }, [base, adminKey, business]);

  const set = (patch: Partial<Voice>) => setVoice(v => (v ? { ...v, ...patch } : v));

  const save = async () => {
    if (!voice) return;
    setSaving(true); setMsg(null);
    try {
      const res = await fetch(`${base}/admin/sectors/${encodeURIComponent(business)}/voice`, {
        method: 'PUT',
        headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice_language: voice.language,
          stt_provider: voice.sttProvider,
          tts_provider: voice.ttsProvider,
          voice_id: voice.voiceId?.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Save failed');
      setVoice(v => ({ ...json.data, sarvamConfigured: v?.sarvamConfigured }));
      setMsg({ text: 'Saved. Takes effect on the next call.', ok: true });
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setSaving(false);
    }
  };

  const voiceHint = voice?.ttsProvider === 'sarvam'
    ? 'Sarvam Bulbul speaker, lowercase (e.g. priya, ritu, shubh). Empty = Sarvam default.'
    : voice?.language === 'en'
      ? 'Cartesia voice id. Empty = the deployment default voice.'
      : 'Cartesia voice id of a Hindi-native voice (required for Hindi on Cartesia).';

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: 16, color: '#fff' }}>Voice &amp; language</h2>
      <p style={{ margin: '0 0 16px', color: '#888', fontSize: 13 }}>
        The language a business answers calls in, and which speech providers it uses. Hindi and Hinglish
        replies follow the caller's language. Sarvam is built for Indian languages; Deepgram + Cartesia
        is the cheaper option.
      </p>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={label}>Business
          <select value={business} onChange={e => setBusiness(e.target.value)} style={select}>
            {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </label>
        <label style={label}>Language
          <select value={voice?.language ?? 'en'} disabled={!voice} onChange={e => set({ language: e.target.value as Voice['language'] })} style={select}>
            {LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </label>
        <label style={label}>Speech recognition
          <select value={voice?.sttProvider ?? 'deepgram'} disabled={!voice} onChange={e => set({ sttProvider: e.target.value as Voice['sttProvider'] })} style={select}>
            <option value="deepgram">Deepgram</option>
            <option value="sarvam">Sarvam (Saaras)</option>
          </select>
        </label>
        <label style={label}>Voice
          <select value={voice?.ttsProvider ?? 'cartesia'} disabled={!voice} onChange={e => set({ ttsProvider: e.target.value as Voice['ttsProvider'] })} style={select}>
            <option value="cartesia">Cartesia</option>
            <option value="sarvam">Sarvam (Bulbul)</option>
          </select>
        </label>
        <label style={{ ...label, flex: 1, minWidth: 220 }}>Voice id
          <input
            value={voice?.voiceId ?? ''}
            disabled={!voice}
            onChange={e => set({ voiceId: e.target.value })}
            placeholder="default"
            style={{ ...select, minWidth: 0 }}
          />
        </label>
        <button
          onClick={save}
          disabled={!voice || saving}
          style={{ background: '#6c47ff', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8, cursor: 'pointer', opacity: !voice || saving ? 0.5 : 1 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {voice && <p style={{ margin: '10px 0 0', fontSize: 12, color: '#666' }}>{voiceHint}</p>}
      {voice && !voice.sarvamConfigured && (voice.sttProvider === 'sarvam' || voice.ttsProvider === 'sarvam') && (
        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#fbbf24' }}>SARVAM_API_KEY isn't set on the Worker, so Sarvam can't be saved yet.</p>
      )}
      {msg && <p style={{ margin: '12px 0 0', fontSize: 13, color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</p>}
    </div>
  );
}
