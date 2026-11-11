import { useState, useRef, useEffect, useCallback } from 'react';
import { formatMoney, type SectorLocale } from '../locale';

interface Turn { role: 'user' | 'assistant'; content: string }
interface ToolCall { name: string; input: unknown; result: unknown }
interface DebugEntry { turn: number; utterance: string; tool_calls: ToolCall[]; error?: string; ts: string }

interface Props { sector: string; base: string; /** Operator: pick any business, set the caller id, see tool debug. */ operator?: boolean }

// ── Speech helpers — Deepgram STT + Cartesia TTS ─────────────────────────────
// Both are proxied through the Worker (/mogi/transcribe, /mogi/tts) so no
// provider API key is ever shipped in the browser bundle.

async function speak(base: string, token: string, text: string, onEnd?: () => void) {
  const res = await fetch(`${base}/mogi/tts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => null);
  if (!res?.ok) { console.error('TTS error', res?.status); onEnd?.(); return; }
  const url = URL.createObjectURL(await res.blob());
  const audio = new Audio(url);
  audio.onended = () => { URL.revokeObjectURL(url); onEnd?.(); };
  audio.play().catch(() => { URL.revokeObjectURL(url); onEnd?.(); });
}

// No shared secret sent from browser — JWT Bearer token is the only auth

// Sectors are loaded from the worker at runtime — no hardcoding needed
type SectorOption = { key: string; name: string } & SectorLocale;

const s = {
  card:  { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 20 } as React.CSSProperties,
  input: { background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-strong)', padding: '9px 13px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' } as React.CSSProperties,
  label: { fontSize: 12, color: 'var(--text-subtle)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5, display: 'block' } as React.CSSProperties,
  btn:   (active: boolean) => ({ background: active ? 'var(--accent)' : 'var(--input-bg)', color: active ? '#fff' : 'var(--text-muted)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8, padding: '9px 18px', fontWeight: 600, fontSize: 13, cursor: active ? 'pointer' : 'default', opacity: active ? 1 : 0.5, whiteSpace: 'nowrap' } as React.CSSProperties),
  tag:   { background: 'var(--surface-2)', color: 'var(--accent-text)', padding: '2px 8px', borderRadius: 99, fontSize: 12, border: '1px solid var(--accent-soft)' } as React.CSSProperties,
};


export default function VoiceTest({ sector: defaultSector, base, operator = false }: Props) {
  const [sector, setSector] = useState(defaultSector);
  const [customerId, setCustomerId] = useState('customer-001');
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<{ tier: string; credit: number } | null>(null);
  const [history, setHistory] = useState<Turn[]>([]);
  const [utterance, setUtterance] = useState('');
  const [loading, setLoading] = useState(false);
  const [debugLog, setDebugLog] = useState<DebugEntry[]>([]);
  const [transcripts, setTranscripts] = useState<any[]>([]);
  const [debugTab, setDebugTab] = useState<'tools' | 'transcripts' | 'session'>('tools');
  const [emailTo, setEmailTo] = useState('');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [sectors, setSectors] = useState<SectorOption[]>([]);
  const [voiceMode, setVoiceMode] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    fetch(`${base}/sectors`).then(r => r.json()).then(json => { if (json.success) setSectors(json.data); }).catch(() => {});
  }, [base]);

  useEffect(() => {
    if (!defaultSector) return;
    // Owners always test their own business; the operator can switch.
    setSector(prev => (operator ? prev || defaultSector : defaultSector));
  }, [defaultSector, operator]);

  useEffect(() => {
    if (!sectors.length) return;
    setSector(prev => {
      if (prev && sectors.some(s => s.key === prev)) return prev;
      if (defaultSector && sectors.some(s => s.key === defaultSector)) return defaultSector;
      return sectors[0].key;
    });
  }, [sectors, defaultSector]);

  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight; }, [history]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); } }, [toast]);

  const notify = (msg: string, ok = true) => setToast({ msg, ok });

  const startSession = async () => {
    try {
      const res = await fetch(`${base}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId, sector, businessType: sector }),
      });
      const json = await res.json();
      if (!json.success) { notify(`Auth failed: ${json.error}`, false); return; }

      stopListening();
      setSpeaking(false);
      setToken(json.data.token);
      setSession({ tier: json.data.account.tier, credit: json.data.account.store_credit_cents });
      setHistory([]);
      setDebugLog([]);
      setTranscripts([]);

      const ctx = await fetch(`${base}/mogi/context`, {
        headers: { 'Authorization': `Bearer ${json.data.token}`, 'Content-Type': 'application/json' },
      });
      const ctxJson = await ctx.json();
      if (ctxJson.success) setHistory([{ role: 'assistant', content: ctxJson.data.greeting }]);
      notify('Session started');
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch (e: any) {
      notify(`Auth error: ${e.message}`, false);
    }
  };

  const sendTurn = useCallback(async (textOverride?: string) => {
    const text = (textOverride ?? utterance).trim();
    if (!text || !token || loading) return;
    if (!textOverride) setUtterance('');
    setLoading(true);
    const turnNum = debugLog.length + 1;
    setHistory(prev => [...prev, { role: 'user', content: text }]);

    try {
      const res = await fetch(`${base}/mogi/voice-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ utterance: text, history }),
      });
      const json = await res.json();
      const toolCalls: ToolCall[] = json.data?.tool_calls ?? json.tool_calls ?? [];
      const entry: DebugEntry = { turn: turnNum, utterance: text, tool_calls: toolCalls, ts: new Date().toLocaleTimeString() };
      if (!json.success) {
        entry.error = json.error ?? 'unknown error';
        setDebugLog(prev => [entry, ...prev]);
        setHistory(prev => [...prev, { role: 'assistant', content: `Error: ${json.error}` }]);
      } else {
        setDebugLog(prev => [entry, ...prev]);
        setHistory(json.data.history);
        // Speak the response in voice mode, then re-arm the mic
        if (voiceMode && json.data.spoken_response) {
          setSpeaking(true);
          speak(base, token, json.data.spoken_response, () => {
            setSpeaking(false);
            startListening();
          });
        }
      }
    } catch (e: any) {
      setHistory(prev => [...prev, { role: 'assistant', content: 'Connection error.' }]);
      notify(e.message, false);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [utterance, token, loading, history, voiceMode, debugLog.length, base]);

  const startListening = useCallback(async () => {
    if (!token || loading) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(
        t => MediaRecorder.isTypeSupported(t)
      ) ?? '';
      chunksRef.current = [];
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setListening(false);
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
        if (blob.size < 1000) return; // too short, ignore
        try {
          const res = await fetch(`${base}/mogi/transcribe`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'audio/webm' },
            body: blob,
          });
          const json = await res.json();
          if (!json.success) { notify(`Transcription failed: ${json.error}`, false); return; }
          const transcript = json.data.transcript;
          if (transcript) sendTurn(transcript);
        } catch (e: any) {
          notify(`Transcription error: ${e.message}`, false);
        }
      };

      recorder.start();
      setListening(true);
    } catch (e: any) {
      notify(`Mic: ${e.message}`, false);
    }
  }, [token, loading, sendTurn, base]);

  const stopListening = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);

  const toggleVoice = () => {
    if (voiceMode) {
      stopListening();
      setSpeaking(false);
      setVoiceMode(false);
    } else {
      setVoiceMode(true);
      startListening();
    }
  };

  const loadTranscripts = async () => {
    if (!token) return;
    const res = await fetch(`${base}/mogi/transcripts`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    if (json.success) { setTranscripts(json.data.transcripts); setDebugTab('transcripts'); }
    else notify('Failed to load transcripts', false);
  };

  const sendEmail = async () => {
    if (!emailTo || !token || !history.length) { notify('Enter email and have a conversation first', false); return; }
    const res = await fetch(`${base}/mogi/email-transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ email: emailTo, history }),
    });
    const json = await res.json();
    if (json.success) notify(`Sent to ${emailTo}`); else notify('Email failed', false);
  };

  const hasSession = !!token;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: operator ? 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))' : 'minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
      {/* ── Left: Chat panel ── */}
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-strong)' }}>Test call</span>
          {operator && session && (
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={s.tag}>{session.tier}</span>
              <span style={s.tag}>{formatMoney(session.credit, sectors.find(x => x.key === sector))} credit</span>
            </div>
          )}
        </div>

        {/* Session setup */}
        <div style={{ display: 'grid', gridTemplateColumns: operator ? '1fr 1fr auto' : '1fr', gap: 10, marginBottom: 14 }}>
          {operator && <><div>
            <label style={s.label}>Customer ID</label>
            <input style={s.input} value={customerId} onChange={e => setCustomerId(e.target.value)} placeholder="customer-001" />
          </div>
          <div>
            <label style={s.label}>Business</label>
            <select style={{ ...s.input, cursor: 'pointer' }} value={sector} onChange={e => setSector(e.target.value)}>
              {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </div></>}
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button onClick={startSession} style={{ ...s.btn(true), background: 'var(--accent)', border: 'none' }}>
              {hasSession ? 'Start over' : 'Start a test call'}
            </button>
          </div>
        </div>

        {/* Chat history */}
        <div ref={chatRef} style={{
          height: 360, overflowY: 'auto', background: 'var(--input-bg)', borderRadius: 10,
          padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
          border: '1px solid var(--border)',
        }}>
          {history.length === 0 && (
            <div style={{ color: 'var(--text-subtle)', fontSize: 13, margin: 'auto', textAlign: 'center' }}>
              Press “Start a test call”, then speak or type as if you were a caller.
            </div>
          )}
          {history.map((msg, i) => (
            <div key={i} style={{
              maxWidth: '80%', padding: '9px 13px', borderRadius: 12, fontSize: 14, lineHeight: 1.5,
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              background: msg.role === 'user' ? 'var(--accent)' : 'var(--surface-2)',
              color: msg.role === 'user' ? '#fff' : 'var(--text)',
              borderBottomRightRadius: msg.role === 'user' ? 3 : 12,
              borderBottomLeftRadius: msg.role === 'user' ? 12 : 3,
            }}>
              {msg.role === 'assistant' && <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginBottom: 3 }}>Assistant</div>}
              {msg.content}
            </div>
          ))}
          {loading && (
            <div style={{ alignSelf: 'flex-start', color: 'var(--text-subtle)', fontSize: 13, fontStyle: 'italic' }}>
              Thinking…
            </div>
          )}
        </div>

        {/* Voice mode toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, padding: '10px 14px', background: 'var(--input-bg)', borderRadius: 10, border: `1px solid ${voiceMode ? 'var(--accent-border)' : 'var(--surface-2)'}` }}>
          <button
            onClick={toggleVoice}
            disabled={!hasSession}
            title={voiceMode ? 'Turn off talking' : 'Talk instead of typing'}
            aria-label={voiceMode ? 'Turn off talking' : 'Talk instead of typing'}
            style={{
              width: 44, height: 44, borderRadius: '50%', border: 'none', cursor: hasSession ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0,
              background: listening ? 'var(--danger)' : voiceMode ? 'var(--accent)' : 'var(--input-bg)',
              boxShadow: listening ? '0 0 0 6px var(--danger-soft)' : voiceMode ? '0 0 0 4px var(--accent-soft)' : 'none',
              transition: 'all 0.2s',
              opacity: hasSession ? 1 : 0.4,
            }}
          >
            {listening ? '🔴' : speaking ? '🔊' : '🎙️'}
          </button>
          <div style={{ flex: 1, fontSize: 13 }}>
            {!hasSession && <span style={{ color: 'var(--text-subtle)' }}>Start a session to use voice</span>}
            {hasSession && !voiceMode && <span style={{ color: 'var(--text-subtle)' }}>Click mic to enable voice mode</span>}
            {hasSession && voiceMode && listening && <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Listening… speak now</span>}
            {hasSession && voiceMode && speaking && <span style={{ color: 'var(--accent-text)', fontWeight: 600 }}>Mogi is speaking…</span>}
            {hasSession && voiceMode && !listening && !speaking && !loading && <span style={{ color: 'var(--success)' }}>Voice mode active — tap mic to speak</span>}
            {hasSession && voiceMode && loading && <span style={{ color: 'var(--warning)' }}>Processing…</span>}
          </div>
          {voiceMode && (
            <button
              onClick={listening ? stopListening : startListening}
              disabled={loading || speaking}
              style={{ ...s.btn(!loading && !speaking), padding: '7px 14px', fontSize: 13 }}
            >
              {listening ? 'Stop' : 'Speak'}
            </button>
          )}
        </div>

        {/* Text input */}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            ref={inputRef}
            style={{ ...s.input, flex: 1 }}
            placeholder={hasSession ? 'Or type what a caller would say…' : 'Start a test call first'}
            value={utterance}
            disabled={!hasSession || loading}
            onChange={e => setUtterance(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') sendTurn(); }}
          />
          <button onClick={() => sendTurn()} disabled={!hasSession || loading} style={s.btn(hasSession && !loading)}>
            Send
          </button>
        </div>

        {/* Email */}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            style={{ ...s.input, flex: 1 }}
            type="email"
            placeholder="Email transcript to…"
            value={emailTo}
            onChange={e => setEmailTo(e.target.value)}
          />
          <button onClick={sendEmail} disabled={!hasSession} style={s.btn(hasSession)}>
            Email transcript
          </button>
        </div>
      </div>

      {/* ── Right: Debug panel (operator only) ── */}
      {operator && <div style={s.card}>
        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 14, background: 'var(--input-bg)', padding: 4, borderRadius: 8 }}>
          {(['tools', 'transcripts', 'session'] as const).map(tab => (
            <button key={tab} onClick={() => { setDebugTab(tab); if (tab === 'transcripts') loadTranscripts(); }}
              style={{
                flex: 1, padding: '6px 0', borderRadius: 6, fontSize: 13, fontWeight: 600,
                border: 'none', cursor: 'pointer', textTransform: 'capitalize',
                background: debugTab === tab ? 'var(--accent)' : 'transparent',
                color: debugTab === tab ? '#fff' : 'var(--text-muted)',
              }}>
              {tab === 'tools' ? `Tools${debugLog.length ? ` (${debugLog.length})` : ''}` : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tool calls */}
        {debugTab === 'tools' && (
          <div style={{ maxHeight: 540, overflowY: 'auto' }}>
            {debugLog.length === 0 && (
              <div style={{ color: 'var(--text-subtle)', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>
                Tool calls will appear here
              </div>
            )}
            {debugLog.map((entry, i) => (
              <div key={i} style={{ marginBottom: 12, borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Turn {entry.turn}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{entry.ts}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--accent-text)', marginBottom: 6 }}>"{entry.utterance}"</div>
                {entry.error && (
                  <div style={{ fontSize: 13, color: 'var(--danger)', background: 'var(--danger-soft)', padding: '6px 10px', borderRadius: 6, marginBottom: 6 }}>
                    Error: {entry.error}
                  </div>
                )}
                {entry.tool_calls.length === 0 && !entry.error && (
                  <div style={{ fontSize: 13, color: 'var(--text-subtle)' }}>No tool calls</div>
                )}
                {entry.tool_calls.map((tc, j) => (
                  <details key={j} style={{ marginBottom: 6 }}>
                    <summary style={{ fontSize: 13, cursor: 'pointer', color: 'var(--success)', fontFamily: 'monospace' }}>
                      {tc.name}
                    </summary>
                    <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-subtle)', fontFamily: 'monospace', background: 'var(--input-bg)', padding: '6px 8px', borderRadius: 4 }}>
                        <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>INPUT</div>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{JSON.stringify(tc.input, null, 2)}</pre>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-subtle)', fontFamily: 'monospace', background: 'var(--input-bg)', padding: '6px 8px', borderRadius: 4 }}>
                        <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>OUTPUT</div>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{JSON.stringify(tc.result, null, 2)}</pre>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Transcripts */}
        {debugTab === 'transcripts' && (
          <div style={{ maxHeight: 540, overflowY: 'auto' }}>
            {transcripts.length === 0 && (
              <div style={{ color: 'var(--text-subtle)', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>
                No saved transcripts
              </div>
            )}
            {transcripts.map((t, i) => (
              <details key={i} style={{ marginBottom: 10, borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
                <summary style={{ fontSize: 13, color: 'var(--text)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{new Date(t.createdAt).toLocaleString()}</span>
                  <span style={{ color: 'var(--text-subtle)', fontSize: 12 }}>
                    {Array.isArray(t.turns) ? t.turns.length : '?'} turns
                    {t.callSid && ` · ${t.callSid.slice(-8)}`}
                  </span>
                </summary>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(Array.isArray(t.turns) ? t.turns : JSON.parse(t.turns ?? '[]')).map((turn: Turn, j: number) => (
                    <div key={j} style={{ fontSize: 13, display: 'flex', gap: 6 }}>
                      <span style={{ color: turn.role === 'user' ? 'var(--accent-text)' : 'var(--success)', minWidth: 70, fontWeight: 600 }}>{turn.role}:</span>
                      <span style={{ color: 'var(--text)' }}>{turn.content}</span>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}

        {/* Session info */}
        {debugTab === 'session' && (
          <div style={{ fontSize: 13 }}>
            {!hasSession ? (
              <div style={{ color: 'var(--text-subtle)', textAlign: 'center', padding: '40px 0' }}>No active session</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  ['Customer ID', customerId],
                  ['Business', sectors.find(s => s.key === sector)?.name ?? sector],
                  ['Tier', session?.tier],
                  ['Store Credit', formatMoney(session?.credit ?? 0, sectors.find(x => x.key === sector))],
                  ['Worker', base],
                  ['Turns', String(history.filter(m => m.role === 'user').length)],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text-subtle)' }}>{k}</span>
                    <span style={{ color: 'var(--text)', fontFamily: k === 'Worker' ? 'monospace' : undefined, fontSize: k === 'Worker' ? 11 : 13 }}>{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24,
          background: toast.ok ? 'var(--success)' : 'var(--danger)',
          color: '#fff', padding: '10px 18px', borderRadius: 8,
          fontSize: 13, fontWeight: 600, zIndex: 999,
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
