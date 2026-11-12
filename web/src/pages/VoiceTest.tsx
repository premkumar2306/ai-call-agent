import { Fragment, useState, useRef, useEffect, useCallback } from 'react';
import { formatMoney, type SectorLocale } from '../locale';
import { Badge, Button, Card, EmptyState, Notice, Segmented } from '../components/ui';

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
  const sectorName = sectors.find(x => x.key === sector)?.name;

  return (
    <div className={operator ? 'grid-2' : 'stack'}>
      {/* ── Test call ── */}
      <Card
        title="Test call"
        description={sectorName && !operator ? `You're the caller; ${sectorName}'s assistant answers.` : undefined}
        actions={operator && session ? <div className="row"><Badge>{session.tier}</Badge><Badge>{formatMoney(session.credit, sectors.find(x => x.key === sector))} credit</Badge></div> : undefined}
      >
        <div className="form-row">
          {operator && <>
            <div className="field grow">
              <label htmlFor="vt-customer">Caller ID</label>
              <input id="vt-customer" className="input" value={customerId} onChange={e => setCustomerId(e.target.value)} placeholder="customer-001" />
            </div>
            <div className="field grow">
              <label htmlFor="vt-business">Business</label>
              <select id="vt-business" className="input" value={sector} onChange={e => setSector(e.target.value)}>
                {sectors.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
            </div>
          </>}
          <Button onClick={startSession}>{hasSession ? 'Start over' : 'Start a test call'}</Button>
        </div>

        <div ref={chatRef} className="chat chat-box" aria-live="polite">
          {history.length === 0 && <p className="chat-empty">Press “Start a test call”, then speak or type as if you were a caller.</p>}
          {history.map((msg, i) => (
            <div key={i} className={`bubble ${msg.role === 'user' ? 'me' : 'them'}`}>
              {msg.role === 'assistant' && <span className="who">Assistant</span>}
              {msg.content}
            </div>
          ))}
          {loading && <p className="muted small">Thinking…</p>}
        </div>

        <div className="voice-bar">
          <button
            type="button"
            onClick={toggleVoice}
            disabled={!hasSession}
            className={`mic${listening ? ' rec' : voiceMode ? ' on' : ''}`}
            title={voiceMode ? 'Turn off talking' : 'Talk instead of typing'}
            aria-label={voiceMode ? 'Turn off talking' : 'Talk instead of typing'}
            aria-pressed={voiceMode}
          >
            {listening ? '🔴' : speaking ? '🔊' : '🎙️'}
          </button>
          <span className="spacer muted">
            {!hasSession && 'Start a test call to talk out loud'}
            {hasSession && !voiceMode && 'Press the microphone to talk, or type below'}
            {hasSession && voiceMode && listening && <span className="bad">Listening… press Stop when you're done</span>}
            {hasSession && voiceMode && speaking && <span className="strong">Speaking…</span>}
            {hasSession && voiceMode && !listening && !speaking && !loading && 'Waiting…'}
          </span>
          {voiceMode && listening && <Button variant="danger" size="sm" onClick={stopListening}>Stop</Button>}
        </div>

        <form className="form-row" onSubmit={e => { e.preventDefault(); sendTurn(); }}>
          <input
            ref={inputRef}
            className="input grow"
            aria-label="What the caller says"
            placeholder={hasSession ? 'Or type what a caller would say…' : 'Start a test call first'}
            value={utterance}
            disabled={!hasSession || loading}
            onChange={e => setUtterance(e.target.value)}
          />
          <Button type="submit" disabled={!hasSession || loading || !utterance.trim()}>Send</Button>
        </form>

        <form className="form-row" onSubmit={e => { e.preventDefault(); sendEmail(); }}>
          <input className="input grow" type="email" aria-label="Email the transcript to" placeholder="Email the transcript to…" value={emailTo} onChange={e => setEmailTo(e.target.value)} />
          <Button type="submit" variant="secondary" disabled={!hasSession}>Email transcript</Button>
        </form>
      </Card>

      {/* ── Debug panel (operator only) ── */}
      {operator && (
        <Card title="Debug">
          <Segmented label="Debug views" value={debugTab} onChange={tab => { setDebugTab(tab); if (tab === 'transcripts') loadTranscripts(); }}
            items={[{ key: 'tools', label: `Tools${debugLog.length ? ` (${debugLog.length})` : ''}` }, { key: 'transcripts', label: 'Transcripts' }, { key: 'session', label: 'Session' }]} />

          {debugTab === 'tools' && (
            <div className="log">
              {debugLog.length === 0 && <EmptyState title="No tool calls yet">They appear here as the assistant uses them.</EmptyState>}
              {debugLog.map((entry, i) => (
                <div key={i} className="log-item">
                  <div className="row-between"><span className="muted">Turn {entry.turn}</span><span className="subtle">{entry.ts}</span></div>
                  <span className="strong">“{entry.utterance}”</span>
                  {entry.error && <Notice tone="error">Error: {entry.error}</Notice>}
                  {entry.tool_calls.length === 0 && !entry.error && <span className="subtle">No tool calls</span>}
                  {entry.tool_calls.map((tc, j) => (
                    <details key={j} className="more">
                      <summary className="mono">{tc.name}</summary>
                      <div className="stack-sm">
                        <span className="subtle">Input</span><pre>{JSON.stringify(tc.input, null, 2)}</pre>
                        <span className="subtle">Output</span><pre>{JSON.stringify(tc.result, null, 2)}</pre>
                      </div>
                    </details>
                  ))}
                </div>
              ))}
            </div>
          )}

          {debugTab === 'transcripts' && (
            <div className="log">
              {transcripts.length === 0 && <EmptyState title="No saved transcripts" />}
              {transcripts.map((t, i) => (
                <details key={i} className="log-item">
                  <summary className="row-between">
                    <span>{new Date(t.createdAt).toLocaleString()}</span>
                    <span className="subtle">{Array.isArray(t.turns) ? t.turns.length : '?'} turns{t.callSid && ` · ${t.callSid.slice(-8)}`}</span>
                  </summary>
                  <div className="stack-sm">
                    {(Array.isArray(t.turns) ? t.turns : JSON.parse(t.turns ?? '[]')).map((turn: Turn, j: number) => (
                      <div key={j}><span className="strong">{turn.role === 'user' ? 'Caller' : 'Assistant'}:</span> {turn.content}</div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          )}

          {debugTab === 'session' && (!hasSession ? <EmptyState title="No active session" /> : (
            <dl className="kv">
              {[
                ['Caller ID', customerId],
                ['Business', sector],
                ['Tier', session?.tier],
                ['Store credit', formatMoney(session?.credit ?? 0, sectors.find(x => x.key === sector))],
                ['Worker', base],
                ['Turns', String(history.filter(m => m.role === 'user').length)],
              ].map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className={k === 'Worker' ? 'mono small' : undefined}>{v}</dd></Fragment>)}
            </dl>
          ))}
        </Card>
      )}

      {toast && <div className={`toast ${toast.ok ? 'ok' : 'bad'}`} role="status">{toast.msg}</div>}
    </div>
  );
}
