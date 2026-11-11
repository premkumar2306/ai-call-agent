import { useEffect, useState } from 'react';
import { card as sharedCard } from '../ui';

interface Props {
  base: string;
  /** authHeaders(): the operator's admin key or an owner's sign-in. */
  auth: Record<string, string>;
  sectors: { key: string; name: string }[];
}

interface Voice {
  language: 'en' | 'hi' | 'hi-en';
  sttProvider: 'deepgram' | 'sarvam';
  ttsProvider: 'cartesia' | 'sarvam';
  voiceId?: string;
  sarvamConfigured?: boolean;
}

const card: React.CSSProperties = sharedCard;
const select: React.CSSProperties = { background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-strong)', padding: '8px 12px', borderRadius: 8, minWidth: 200 };
const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, fontWeight: 500, color: 'var(--text)' };

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'hi-en', label: 'Hinglish (Hindi + English)' },
];

// Per-business phone-line language and speech providers (PUT /admin/sectors/:key/voice).
export default function VoiceSettings({ base, auth, sectors }: Props) {
  const [business, setBusiness] = useState('');
  const [voice, setVoice] = useState<Voice | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!business && sectors.length) setBusiness(sectors[0].key); }, [sectors, business]);

  useEffect(() => {
    setVoice(null); setMsg(null);
    if (!Object.keys(auth).length || !business) return;
    fetch(`${base}/admin/sectors/${encodeURIComponent(business)}/voice`, { headers: auth })
      .then(r => r.json())
      .then(json => {
        if (!json.success) throw new Error(json.error ?? 'Failed to load');
        setVoice(json.data);
      })
      .catch((e: any) => setMsg({ text: e.message === 'Admin key required' ? 'Sign in to manage this.' : e.message, ok: false }));
  }, [base, auth, business]);

  const set = (patch: Partial<Voice>) => setVoice(v => (v ? { ...v, ...patch } : v));

  const save = async () => {
    if (!voice) return;
    setSaving(true); setMsg(null);
    try {
      const res = await fetch(`${base}/admin/sectors/${encodeURIComponent(business)}/voice`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
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
      <h2 style={{ margin: '0 0 4px', fontSize: 17, color: 'var(--text-strong)' }}>Language and voice</h2>
      <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 13 }}>
        The language the assistant answers calls in. In Hindi or Hinglish it follows the caller's language.
        The Indian-language options understand and sound more natural in Hindi; the standard options cost less.
      </p>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {sectors.length > 1 && <label style={label}>Business
          <select value={business} onChange={e => setBusiness(e.target.value)} style={select}>
            {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </label>}
        <label style={label}>Language
          <select value={voice?.language ?? 'en'} disabled={!voice} onChange={e => set({ language: e.target.value as Voice['language'] })} style={select}>
            {LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </label>
        <label style={label}>Speech recognition (hearing callers)
          <select value={voice?.sttProvider ?? 'deepgram'} disabled={!voice} onChange={e => set({ sttProvider: e.target.value as Voice['sttProvider'] })} style={select}>
            <option value="deepgram">Standard (Deepgram)</option>
            <option value="sarvam">Indian languages (Sarvam)</option>
          </select>
        </label>
        <label style={label}>Voice (speaking to callers)
          <select value={voice?.ttsProvider ?? 'cartesia'} disabled={!voice} onChange={e => set({ ttsProvider: e.target.value as Voice['ttsProvider'] })} style={select}>
            <option value="cartesia">Standard (Cartesia)</option>
            <option value="sarvam">Indian voice (Sarvam)</option>
          </select>
        </label>
        <label style={{ ...label, flex: 1, minWidth: 220 }}>Voice ID (optional)
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
          style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8, cursor: 'pointer', opacity: !voice || saving ? 0.5 : 1 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {voice && <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--text-subtle)' }}>{voiceHint}</p>}
      {voice && !voice.sarvamConfigured && (voice.sttProvider === 'sarvam' || voice.ttsProvider === 'sarvam') && (
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--warning)' }}>The Indian-language option isn't switched on for this service yet (SARVAM_API_KEY), so it can't be saved.</p>
      )}
      {msg && <p style={{ margin: '12px 0 0', fontSize: 13, color: msg.ok ? 'var(--success)' : 'var(--danger)' }}>{msg.text}</p>}
    </div>
  );
}
