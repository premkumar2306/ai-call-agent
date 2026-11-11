import { useState, useEffect, useCallback } from 'react';
import { Button, Card, Field, Notice } from '../components/ui';

// The assistant's name and greeting (GET|PUT /admin/config/:key). The whole
// config is sent back on save, so the online-store fields the operator sees
// under "More" are kept as they are for everyone else.

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
  /** X-Admin-Key or owner Bearer header (see auth.ts) */
  auth: Record<string, string>;
  canEdit?: boolean;
  operator?: boolean;
}

export default function Dashboard({ sector, base, auth, canEdit = true, operator = false }: Props) {
  const [cfg, setCfg] = useState<SectorConfig | null>(null);
  const [saving, setSaving] = useState(false);
  // The phone line's language: a custom greeting is spoken exactly as typed.
  const [voiceLanguage, setVoiceLanguage] = useState<string>('en');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const loadConfig = useCallback(async () => {
    setCfg(null); setMsg(null);
    try {
      if (!sector || !Object.keys(auth).length) return;
      const res = await fetch(`${base}/admin/config/${sector}`, { headers: auth });
      const json = await res.json();
      if (json.success) setCfg(json.data);
      else setMsg({ text: res.status === 401 || res.status === 403 ? 'You are not signed in for this business.' : 'Could not load the assistant settings.', ok: false });
    } catch {
      setMsg({ text: 'Could not load the assistant settings.', ok: false });
    }
  }, [sector, base, auth]);

  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => {
    setVoiceLanguage('en');
    if (!sector || !Object.keys(auth).length) return;
    fetch(`${base}/admin/sectors/${encodeURIComponent(sector)}/voice`, { headers: auth })
      .then(r => r.json()).then(j => { if (j.success) setVoiceLanguage(j.data.language ?? 'en'); }).catch(() => {});
  }, [sector, base, auth]);

  const handleSave = async () => {
    if (!cfg) return;
    setSaving(true); setMsg(null);
    try {
      const res = await fetch(`${base}/admin/config/${sector}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(cfg),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) { setMsg({ text: 'Saved. Callers hear it from the next call.', ok: true }); if (json.data) setCfg(json.data); }
      else setMsg({ text: json.error ?? 'Save failed', ok: false });
    } catch {
      setMsg({ text: 'Save failed. Check your connection and try again.', ok: false });
    } finally {
      setSaving(false);
    }
  };

  const set = (field: keyof SectorConfig) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setCfg(prev => prev && ({ ...prev, [field]: field === 'maxRecommendations' ? parseInt((e.target as HTMLInputElement).value) || 3 : e.target.value }));

  return (
    <Card title="Name and greeting" description="What callers hear when the assistant picks up.">
      {!cfg ? (msg ? <Notice tone="error">{msg.text}</Notice> : <p className="muted" role="status">Loading…</p>) : (
        <div className="stack">
          <Field label="Assistant's name" help="The name it gives callers, e.g. “Hi, this is Avery”.">
            {id => <input id={id} className="input" style={{ maxWidth: 320 }} value={cfg.agentName} onChange={set('agentName')} placeholder="Avery" maxLength={30} disabled={!canEdit} />}
          </Field>
          <Field label="Greeting" help={voiceLanguage === 'en' ? 'The first thing callers hear. Leave it short.' : undefined}>
            {id => <textarea id={id} className="input" value={cfg.greeting} onChange={set('greeting')} placeholder="Welcome! How can I help you today?" disabled={!canEdit} />}
          </Field>
          {voiceLanguage !== 'en' && (
            <Notice tone="warning">
              Your phone line speaks {voiceLanguage === 'hi' ? 'Hindi' : 'Hinglish'}. The greeting is spoken exactly as typed, so write it in
              {voiceLanguage === 'hi' ? ' Hindi (Devanagari), e.g. “शर्मा क्लिनिक में आपका स्वागत है।”' : ' Hinglish, with Hindi words in Devanagari, e.g. “शर्मा क्लिनिक में आपका स्वागत है! Appointment के लिए हम मदद कर सकते हैं।”'}
            </Notice>
          )}
          {operator && (
            <details className="more">
              <summary>Online store settings</summary>
              <div className="form-grid" style={{ marginTop: 12 }}>
                <Field label="Store name">{id => <input id={id} className="input" value={cfg.storeName} onChange={set('storeName')} />}</Field>
                <Field label="Support email">{id => <input id={id} className="input" type="email" value={cfg.supportEmail} onChange={set('supportEmail')} />}</Field>
                <Field label="Products to suggest at once">{id => <input id={id} className="input" type="number" min={1} max={10} value={cfg.maxRecommendations} onChange={set('maxRecommendations')} />}</Field>
                <Field label="Brand colour">{id => <input id={id} type="color" value={cfg.primaryColor} onChange={e => setCfg({ ...cfg, primaryColor: e.target.value })} style={{ width: 56, height: 38, border: 0, background: 'none' }} />}</Field>
              </div>
            </details>
          )}
          {canEdit && <div><Button onClick={handleSave} busy={saving}>Save</Button></div>}
          {msg && <Notice tone={msg.ok ? 'success' : 'error'}>{msg.text}</Notice>}
        </div>
      )}
    </Card>
  );
}
