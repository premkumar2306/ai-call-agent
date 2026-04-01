import { useState, useRef, useEffect, useCallback } from 'react';

interface Turn { role: 'user' | 'assistant'; content: string }
interface ToolCall { name: string; input: unknown; result: unknown }
interface DebugEntry { turn: number; utterance: string; tool_calls: ToolCall[]; error?: string; ts: string }

interface Props { sector: string; base: string }

// ── Speech helpers ────────────────────────────────────────────────────────────

const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

function speak(text: string, onEnd?: () => void) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'en-US';
  utt.rate = 1.05;
  // Prefer a female voice if available
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v => /samantha|zira|google us english|joanna/i.test(v.name))
    ?? voices.find(v => v.lang === 'en-US' && v.name.toLowerCase().includes('female'))
    ?? voices.find(v => v.lang === 'en-US')
    ?? null;
  if (preferred) utt.voice = preferred;
  if (onEnd) utt.onend = onEnd;
  window.speechSynthesis.speak(utt);
}

// No shared secret sent from browser — JWT Bearer token is the only auth

// Sectors are loaded from the worker at runtime — no hardcoding needed
type SectorOption = { key: string; name: string };

const s = {
  card:  { background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 14, padding: 20 } as React.CSSProperties,
  input: { background: '#0a0a0f', border: '1px solid #2a2a3a', borderRadius: 8, color: '#fff', padding: '9px 13px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' } as React.CSSProperties,
  label: { fontSize: 11, color: '#666', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5, display: 'block' } as React.CSSProperties,
  btn:   (active: boolean) => ({ background: active ? '#6c47ff' : '#1e1e2e', color: active ? '#fff' : '#888', border: `1px solid ${active ? '#6c47ff' : '#2a2a3a'}`, borderRadius: 8, padding: '9px 18px', fontWeight: 600, fontSize: 13, cursor: active ? 'pointer' : 'default', opacity: active ? 1 : 0.5, whiteSpace: 'nowrap' } as React.CSSProperties),
  tag:   { background: '#1a1a2e', color: '#a78bff', padding: '2px 8px', borderRadius: 99, fontSize: 11, border: '1px solid #6c47ff33' } as React.CSSProperties,
};

export default function VoiceTest({ sector: defaultSector, base }: Props) {
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
  const srRef = useRef<any>(null);

  useEffect(() => {
    fetch(`${base}/sectors`).then(r => r.json()).then(json => { if (json.success) setSectors(json.data); }).catch(() => {});
  }, [base]);

  useEffect(() => {
    if (!defaultSector) return;
    setSector(prev => prev || defaultSector);
  }, [defaultSector]);

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
      window.speechSynthesis?.cancel();
      setSpeaking(false);
      setToken(json.data.token);
      setSession({ tier: json.data.account.tier, credit: json.data.account.store_credit_cents });
      setHistory([]);
      setDebugLog([]);
      setTranscripts([]);

      const ctx = await fetch(`${base}/avery/context`, {
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
      const res = await fetch(`${base}/avery/voice-turn`, {
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
          speak(json.data.spoken_response, () => {
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

  const startListening = useCallback(() => {
    if (!SR || !token || loading) return;
    const sr = new SR();
    srRef.current = sr;
    sr.lang = 'en-US';
    sr.interimResults = false;
    sr.maxAlternatives = 1;
    sr.onstart = () => setListening(true);
    sr.onend = () => setListening(false);
    sr.onerror = (e: any) => { setListening(false); if (e.error !== 'no-speech') notify(`Mic: ${e.error}`, false); };
    sr.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setListening(false);
      sendTurn(transcript);
    };
    sr.start();
  }, [token, loading, sendTurn]);

  const stopListening = useCallback(() => {
    srRef.current?.stop();
    setListening(false);
  }, []);

  const toggleVoice = () => {
    if (voiceMode) {
      stopListening();
      window.speechSynthesis?.cancel();
      setSpeaking(false);
      setVoiceMode(false);
    } else {
      if (!SR) { notify('Speech recognition not supported in this browser', false); return; }
      setVoiceMode(true);
      startListening();
    }
  };

  const loadTranscripts = async () => {
    if (!token) return;
    const res = await fetch(`${base}/avery/transcripts`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    if (json.success) { setTranscripts(json.data.transcripts); setDebugTab('transcripts'); }
    else notify('Failed to load transcripts', false);
  };

  const sendEmail = async () => {
    if (!emailTo || !token || !history.length) { notify('Enter email and have a conversation first', false); return; }
    const res = await fetch(`${base}/avery/email-transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ email: emailTo, history }),
    });
    const json = await res.json();
    if (json.success) notify(`Sent to ${emailTo}`); else notify('Email failed', false);
  };

  const hasSession = !!token;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 20, alignItems: 'start' }}>
      {/* ── Left: Chat panel ── */}
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Voice Test</span>
          {session && (
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={s.tag}>{session.tier}</span>
              <span style={s.tag}>${(session.credit / 100).toFixed(2)} credit</span>
            </div>
          )}
        </div>

        {/* Session setup */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, marginBottom: 14 }}>
          <div>
            <label style={s.label}>Customer ID</label>
            <input style={s.input} value={customerId} onChange={e => setCustomerId(e.target.value)} placeholder="customer-001" />
          </div>
          <div>
            <label style={s.label}>Business</label>
            <select
              style={{ ...s.input, cursor: 'pointer' }}
              value={sector}
              onChange={e => setSector(e.target.value)}
            >
              {sectors.map(s => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button onClick={startSession} style={{ ...s.btn(true), background: '#6c47ff', border: 'none' }}>
              {hasSession ? 'Restart' : 'Start Session'}
            </button>
          </div>
        </div>

        {/* Chat history */}
        <div ref={chatRef} style={{
          height: 360, overflowY: 'auto', background: '#0a0a0f', borderRadius: 10,
          padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
          border: '1px solid #1a1a2a',
        }}>
          {history.length === 0 && (
            <div style={{ color: '#444', fontSize: 13, margin: 'auto', textAlign: 'center' }}>
              Start a session to begin
            </div>
          )}
          {history.map((msg, i) => (
            <div key={i} style={{
              maxWidth: '80%', padding: '9px 13px', borderRadius: 12, fontSize: 14, lineHeight: 1.5,
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              background: msg.role === 'user' ? '#6c47ff' : '#1e1e2e',
              color: msg.role === 'user' ? '#fff' : '#e0e0e0',
              borderBottomRightRadius: msg.role === 'user' ? 3 : 12,
              borderBottomLeftRadius: msg.role === 'user' ? 12 : 3,
            }}>
              {msg.role === 'assistant' && <div style={{ fontSize: 10, color: '#666', marginBottom: 3 }}>AVERY</div>}
              {msg.content}
            </div>
          ))}
          {loading && (
            <div style={{ alignSelf: 'flex-start', color: '#555', fontSize: 13, fontStyle: 'italic' }}>
              Avery is thinking…
            </div>
          )}
        </div>

        {/* Voice mode toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, padding: '10px 14px', background: '#0a0a0f', borderRadius: 10, border: `1px solid ${voiceMode ? '#6c47ff55' : '#1a1a2a'}` }}>
          <button
            onClick={toggleVoice}
            disabled={!hasSession}
            title={voiceMode ? 'Disable voice mode' : 'Enable voice mode'}
            style={{
              width: 44, height: 44, borderRadius: '50%', border: 'none', cursor: hasSession ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0,
              background: listening ? '#ef4444' : voiceMode ? '#6c47ff' : '#1e1e2e',
              boxShadow: listening ? '0 0 0 6px #ef444433' : voiceMode ? '0 0 0 4px #6c47ff33' : 'none',
              transition: 'all 0.2s',
              opacity: hasSession ? 1 : 0.4,
            }}
          >
            {listening ? '🔴' : speaking ? '🔊' : '🎙️'}
          </button>
          <div style={{ flex: 1, fontSize: 13 }}>
            {!hasSession && <span style={{ color: '#444' }}>Start a session to use voice</span>}
            {hasSession && !voiceMode && <span style={{ color: '#666' }}>Click mic to enable voice mode</span>}
            {hasSession && voiceMode && listening && <span style={{ color: '#ef4444', fontWeight: 600 }}>Listening… speak now</span>}
            {hasSession && voiceMode && speaking && <span style={{ color: '#a78bff', fontWeight: 600 }}>Avery is speaking…</span>}
            {hasSession && voiceMode && !listening && !speaking && !loading && <span style={{ color: '#4ade80' }}>Voice mode active — tap mic to speak</span>}
            {hasSession && voiceMode && loading && <span style={{ color: '#facc15' }}>Processing…</span>}
          </div>
          {voiceMode && (
            <button
              onClick={listening ? stopListening : startListening}
              disabled={loading || speaking}
              style={{ ...s.btn(!loading && !speaking), padding: '7px 14px', fontSize: 12 }}
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
            placeholder={hasSession ? 'Or type an utterance…' : 'Start a session first'}
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
            Send Transcript
          </button>
        </div>
      </div>

      {/* ── Right: Debug panel ── */}
      <div style={s.card}>
        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 2, marginBottom: 14, background: '#0a0a0f', padding: 4, borderRadius: 8 }}>
          {(['tools', 'transcripts', 'session'] as const).map(tab => (
            <button key={tab} onClick={() => { setDebugTab(tab); if (tab === 'transcripts') loadTranscripts(); }}
              style={{
                flex: 1, padding: '6px 0', borderRadius: 6, fontSize: 12, fontWeight: 600,
                border: 'none', cursor: 'pointer', textTransform: 'capitalize',
                background: debugTab === tab ? '#6c47ff' : 'transparent',
                color: debugTab === tab ? '#fff' : '#666',
              }}>
              {tab === 'tools' ? `Tools${debugLog.length ? ` (${debugLog.length})` : ''}` : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tool calls */}
        {debugTab === 'tools' && (
          <div style={{ maxHeight: 540, overflowY: 'auto' }}>
            {debugLog.length === 0 && (
              <div style={{ color: '#444', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>
                Tool calls will appear here
              </div>
            )}
            {debugLog.map((entry, i) => (
              <div key={i} style={{ marginBottom: 12, borderBottom: '1px solid #1e1e2e', paddingBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: '#888' }}>Turn {entry.turn}</span>
                  <span style={{ fontSize: 11, color: '#555' }}>{entry.ts}</span>
                </div>
                <div style={{ fontSize: 13, color: '#a78bff', marginBottom: 6 }}>"{entry.utterance}"</div>
                {entry.error && (
                  <div style={{ fontSize: 12, color: '#f87171', background: '#1a0a0a', padding: '6px 10px', borderRadius: 6, marginBottom: 6 }}>
                    Error: {entry.error}
                  </div>
                )}
                {entry.tool_calls.length === 0 && !entry.error && (
                  <div style={{ fontSize: 12, color: '#444' }}>No tool calls</div>
                )}
                {entry.tool_calls.map((tc, j) => (
                  <details key={j} style={{ marginBottom: 6 }}>
                    <summary style={{ fontSize: 12, cursor: 'pointer', color: '#4ade80', fontFamily: 'monospace' }}>
                      {tc.name}
                    </summary>
                    <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                      <div style={{ fontSize: 11, color: '#666', fontFamily: 'monospace', background: '#0a0a0f', padding: '6px 8px', borderRadius: 4 }}>
                        <div style={{ color: '#888', marginBottom: 2 }}>INPUT</div>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#ccc' }}>{JSON.stringify(tc.input, null, 2)}</pre>
                      </div>
                      <div style={{ fontSize: 11, color: '#666', fontFamily: 'monospace', background: '#0a0a0f', padding: '6px 8px', borderRadius: 4 }}>
                        <div style={{ color: '#888', marginBottom: 2 }}>OUTPUT</div>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#ccc' }}>{JSON.stringify(tc.result, null, 2)}</pre>
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
              <div style={{ color: '#444', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>
                No saved transcripts
              </div>
            )}
            {transcripts.map((t, i) => (
              <details key={i} style={{ marginBottom: 10, borderBottom: '1px solid #1e1e2e', paddingBottom: 10 }}>
                <summary style={{ fontSize: 13, color: '#ccc', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{new Date(t.createdAt).toLocaleString()}</span>
                  <span style={{ color: '#666', fontSize: 11 }}>
                    {Array.isArray(t.turns) ? t.turns.length : '?'} turns
                    {t.callSid && ` · ${t.callSid.slice(-8)}`}
                  </span>
                </summary>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(Array.isArray(t.turns) ? t.turns : JSON.parse(t.turns ?? '[]')).map((turn: Turn, j: number) => (
                    <div key={j} style={{ fontSize: 12, display: 'flex', gap: 6 }}>
                      <span style={{ color: turn.role === 'user' ? '#a78bff' : '#4ade80', minWidth: 70, fontWeight: 600 }}>{turn.role}:</span>
                      <span style={{ color: '#ccc' }}>{turn.content}</span>
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
              <div style={{ color: '#444', textAlign: 'center', padding: '40px 0' }}>No active session</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  ['Customer ID', customerId],
                  ['Business', sectors.find(s => s.key === sector)?.name ?? sector],
                  ['Tier', session?.tier],
                  ['Store Credit', `$${((session?.credit ?? 0) / 100).toFixed(2)}`],
                  ['Worker', base],
                  ['Turns', String(history.filter(m => m.role === 'user').length)],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #1a1a2a' }}>
                    <span style={{ color: '#666' }}>{k}</span>
                    <span style={{ color: '#ccc', fontFamily: k === 'Worker' ? 'monospace' : undefined, fontSize: k === 'Worker' ? 11 : 13 }}>{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24,
          background: toast.ok ? '#22c55e' : '#ef4444',
          color: '#fff', padding: '10px 18px', borderRadius: 8,
          fontSize: 13, fontWeight: 600, zIndex: 999,
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
