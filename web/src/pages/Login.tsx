import { useState } from 'react';
import { api, type Me } from '../auth';
import { btn, card, ghost, h2, hint, input, label, msgStyle } from '../ui';

interface Props {
  base: string;
  onSignedIn: (token: string, me: Me) => void;
  onAdminKey: (key: string) => void;
}

// Sign up and sign in are the same: enter your email, then the 6-digit code.
export default function Login({ base, onSignedIn, onAdminKey }: Props) {
  const [step, setStep] = useState<'email' | 'code' | 'admin'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const sendCode = async () => {
    setBusy(true); setMsg(null);
    try {
      const data = await api<{ devCode?: string }>(base, '/account/login/start', {}, { body: { email } });
      setStep('code');
      setCode(data.devCode ?? '');
      setMsg({ text: data.devCode ? `Development server: your code is ${data.devCode}` : `We sent a 6-digit code to ${email.trim()}. It expires in 10 minutes.`, ok: true });
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true); setMsg(null);
    try {
      const data = await api<Me & { token: string }>(base, '/account/login/verify', {}, { body: { email, code: code.trim() } });
      onSignedIn(data.token, { user: data.user, businesses: data.businesses });
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
      setBusy(false);
    }
  };

  return (
    <div style={{ ...card, padding: 28 }}>
      {step === 'admin' ? (
        <form onSubmit={e => { e.preventDefault(); if (adminKey) onAdminKey(adminKey); }} style={{ display: 'grid', gap: 14 }}>
          <h2 style={h2}>Operator sign-in</h2>
          <p style={{ ...hint, margin: 0 }}>Use the deployment's admin key (ADMIN_SECRET). It's kept for this tab only.</p>
          <input style={input} type="password" autoComplete="off" value={adminKey} onChange={e => setAdminKey(e.target.value)} placeholder="X-Admin-Key" />
          <button style={btn} disabled={!adminKey}>Continue</button>
          <button type="button" style={ghost} onClick={() => setStep('email')}>Back to email sign-in</button>
        </form>
      ) : (
        <form onSubmit={e => { e.preventDefault(); step === 'email' ? sendCode() : verify(); }} style={{ display: 'grid', gap: 14 }}>
          <h2 style={h2}>Sign in to Avery</h2>
          <p style={{ ...hint, margin: 0 }}>New here? Enter your email and we'll set up your account — no password needed.</p>
          <label style={label}>
            Email
            <input style={input} type="email" autoComplete="email" required value={email} disabled={step === 'code'}
              onChange={e => setEmail(e.target.value)} placeholder="you@yourbusiness.com" />
          </label>
          {step === 'code' && (
            <label style={label}>
              6-digit code
              <input style={{ ...input, letterSpacing: 6, fontSize: 20 }} inputMode="numeric" autoComplete="one-time-code"
                maxLength={6} autoFocus value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
            </label>
          )}
          <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy || (step === 'code' && code.length !== 6)}>
            {busy ? 'Please wait…' : step === 'email' ? 'Email me a code' : 'Sign in'}
          </button>
          {step === 'code' && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" style={ghost} disabled={busy} onClick={sendCode}>Send a new code</button>
              <button type="button" style={ghost} onClick={() => { setStep('email'); setCode(''); setMsg(null); }}>Use another email</button>
            </div>
          )}
          {msg && <p style={msgStyle(msg.ok)}>{msg.text}</p>}
          <button type="button" onClick={() => { setStep('admin'); setMsg(null); }}
            style={{ background: 'none', border: 'none', color: 'var(--text-subtle)', fontSize: 13, cursor: 'pointer', justifySelf: 'start', padding: 0 }}>
            Operator? Sign in with the admin key
          </button>
        </form>
      )}
    </div>
  );
}
