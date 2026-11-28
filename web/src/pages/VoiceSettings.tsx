import { useEffect, useState } from 'react';
import { Button, Card, Status, NotAvailable } from '../components/ui';

interface Props {
  base: string;
  /** authHeaders(): the operator's admin key or an owner's sign-in. */
  auth: Record<string, string>;
  sectors: { key: string; name: string }[];
}

interface Voice {
  language: 'en' | 'hi' | 'hi-en' | 'kn' | 'te' | 'ta';
  sttProvider: 'deepgram' | 'sarvam';
  ttsProvider: 'cartesia' | 'sarvam';
  voiceId?: string;
  sarvamConfigured?: boolean;
  // How calls feel (what the line uses now; automatic until saved).
  speakingRate?: 'slow' | 'normal' | 'fast';
  interruptionSensitivity?: 'low' | 'normal' | 'high';
  endpointing?: 'patient' | 'normal';
  noiseCancellation?: boolean;
}

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'hi-en', label: 'Hinglish (Hindi + English)' },
  { value: 'kn', label: 'Kannada (Indian languages voice only)' },
  { value: 'te', label: 'Telugu (Indian languages voice only)' },
  { value: 'ta', label: 'Tamil (Indian languages voice only)' },
];
// Kannada, Telugu and Tamil run on Sarvam for both hearing and speaking.
const SARVAM_ONLY = ['kn', 'te', 'ta'];

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
          speaking_rate: voice.speakingRate,
          interruption_sensitivity: voice.interruptionSensitivity,
          endpointing: voice.endpointing,
          noise_cancellation: voice.noiseCancellation,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Save failed');
      setVoice(v => ({ ...json.data, sarvamConfigured: v?.sarvamConfigured }));
      setMsg({ text: json.pending ? 'Saved.' : 'Saved. Takes effect on the next call.', ok: true });
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setSaving(false);
    }
  };

  const voiceHint = voice?.ttsProvider === 'sarvam'
    ? 'Voice ID: a speaker name in lowercase (e.g. priya, ritu, shubh). Leave empty for the default speaker.'
    : voice?.language === 'en'
      ? 'Voice ID: leave empty for the standard voice.'
      : 'Voice ID of a Hindi-speaking voice (needed for Hindi with the standard voice).';

  return (
    <Card
      title="Language and voice"
      description="The language the assistant answers calls in. In Hindi or Hinglish it follows the caller's language. The Indian-language options understand and sound more natural in Hindi; the standard options cost less."
    >
      <div className="form-grid">
        {sectors.length > 1 && (
          <div className="field">
            <label htmlFor="vs-biz">Business</label>
            <select id="vs-biz" className="input" value={business} onChange={e => setBusiness(e.target.value)}>
              {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="vs-lang">Language</label>
          <select id="vs-lang" className="input" value={voice?.language ?? 'en'} disabled={!voice} onChange={e => set(SARVAM_ONLY.includes(e.target.value) ? { language: e.target.value as Voice['language'], sttProvider: 'sarvam', ttsProvider: 'sarvam' } : { language: e.target.value as Voice['language'] })}>
            {LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="vs-stt">Speech recognition (hearing callers)</label>
          <select id="vs-stt" className="input" value={voice?.sttProvider ?? 'deepgram'} disabled={!voice} onChange={e => set({ sttProvider: e.target.value as Voice['sttProvider'] })}>
            <option value="deepgram">Standard (Deepgram)</option>
            <option value="sarvam">Indian languages (Sarvam)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="vs-tts">Voice (speaking to callers)</label>
          <select id="vs-tts" className="input" value={voice?.ttsProvider ?? 'cartesia'} disabled={!voice} onChange={e => set({ ttsProvider: e.target.value as Voice['ttsProvider'] })}>
            <option value="cartesia">Standard (Cartesia)</option>
            <option value="sarvam">Indian voice (Sarvam)</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="vs-voice">Voice ID (optional)</label>
        <input id="vs-voice" className="input input-narrow" value={voice?.voiceId ?? ''} disabled={!voice} onChange={e => set({ voiceId: e.target.value })} placeholder="default" />
        {voice && <span className="help">{voiceHint}</span>}
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="vs-rate">Speaking speed</label>
          <select id="vs-rate" className="input" value={voice?.speakingRate ?? 'normal'} disabled={!voice} onChange={e => set({ speakingRate: e.target.value as Voice['speakingRate'] })}>
            <option value="slow">Slower (easier to follow on a phone)</option>
            <option value="normal">Normal</option>
            <option value="fast">Faster</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="vs-interrupt">How easily callers can interrupt</label>
          <select id="vs-interrupt" className="input" value={voice?.interruptionSensitivity ?? 'normal'} disabled={!voice} onChange={e => set({ interruptionSensitivity: e.target.value as Voice['interruptionSensitivity'] })}>
            <option value="low">Hard (ignores noise and "haan"; needs a few words)</option>
            <option value="normal">Normal</option>
            <option value="high">Easy (stops at the first sound)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="vs-wait">Wait for the caller to finish</label>
          <select id="vs-wait" className="input" value={voice?.endpointing ?? 'normal'} disabled={!voice} onChange={e => set({ endpointing: e.target.value as Voice['endpointing'] })}>
            <option value="patient">Patient (waits through pauses)</option>
            <option value="normal">Normal</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="vs-noise">Reduce background noise</label>
          <select id="vs-noise" className="input" value={voice?.noiseCancellation ? 'on' : 'off'} disabled={!voice} onChange={e => set({ noiseCancellation: e.target.value === 'on' })}>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
          {voice && <span className="help">Works on Plivo phone lines.</span>}
        </div>
      </div>
      {voice && !voice.sarvamConfigured && (voice.sttProvider === 'sarvam' || voice.ttsProvider === 'sarvam') && (
        <NotAvailable feature="Hindi and Hinglish calls" plural>We've saved your choice; your line stays in English until the Avery team switches it on.</NotAvailable>
      )}
      <div className="form-actions"><Button onClick={save} disabled={!voice} busy={saving}>Save</Button></div>
      <Status msg={msg} />
    </Card>
  );
}
