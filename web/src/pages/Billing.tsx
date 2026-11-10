import { useEffect, useState } from 'react';

// Billing tab: plan, minutes this month, GST-inclusive amounts, invoices and
// the Razorpay Checkout button. Cost and margin come back from the API only
// for the operator (today: anyone with the admin key), so an owner login will
// see the same page without them.

interface Props { sector: string; base: string; adminKey: string }

interface Gst { amountPaise: number; gstPaise: number; totalPaise: number; cgst: number; sgst: number; igst: number }
interface Summary {
  state: 'off' | 'trialing' | 'active' | 'past_due' | 'cancelled' | 'unpaid';
  razorpayConfigured: boolean;
  razorpayKeyId: string | null;
  plan: null | {
    id: string; name: string; currency: string; includedMinutes: number; overagePaisePerMinute: number;
    trialDays: number; gstRateBps: number; monthly: Gst; checkoutReady: boolean;
  };
  account: null | {
    trialEndsAt: number | null; subscriptionId: string | null; subscriptionStatus: string | null; currentPeriodEnd: number | null;
    legalName: string | null; gstin: string | null; billingEmail: string | null; addressLine1: string | null; addressLine2: string | null;
    city: string | null; state: string | null; postalCode: string | null; country: string;
  };
  supplierGstin: string | null;
  usage: {
    period: string; minutes: number; calls: number; whatsappConversations: number; includedMinutes: number | null;
    alertLevel: 0 | 80 | 100; overageSoFar: null | (Gst & { minutes: number });
  };
  invoices: Array<Gst & { period: string; status: string; minutesUsed: number; includedMinutes: number; overageMinutes: number }>;
  cost?: {
    usdToInr: number; costPaise: number; costPerMinutePaise: number | null; revenuePaise: number;
    revenuePerMinutePaise: number | null; marginPaise: number | null; testCalls: number;
  };
}
interface Plan { id: string; name: string; monthlyFeePaise: number; includedMinutes: number; overagePaisePerMinute: number; razorpayPlanId: string | null; isActive: boolean }

declare global {
  interface Window { Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (e: string, cb: (r: any) => void) => void } }
}

const card: React.CSSProperties = { background: '#12121a', border: '1px solid #222', borderRadius: 12, padding: 20 };
const btn: React.CSSProperties = { background: '#6c47ff', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 8, cursor: 'pointer' };
const ghost: React.CSSProperties = { background: 'transparent', color: '#a78bff', border: '1px solid #6c47ff66', padding: '8px 14px', borderRadius: 8, cursor: 'pointer' };
const input: React.CSSProperties = { background: '#1e1e2e', border: '1px solid #2a2a3a', color: '#fff', padding: '8px 12px', borderRadius: 8, width: '100%', boxSizing: 'border-box' };
const muted: React.CSSProperties = { color: '#888', fontSize: 13 };
const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: '#888', fontWeight: 500, fontSize: 12 };
const td: React.CSSProperties = { padding: '6px 8px', fontSize: 13, borderTop: '1px solid #1e1e2e' };

export const inr = (paise: number) =>
  '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATE_LABEL: Record<Summary['state'], [string, string]> = {
  off: ['Billing off', '#888'],
  trialing: ['Free trial', '#4ade80'],
  active: ['Subscribed', '#4ade80'],
  past_due: ['Payment failed', '#f87171'],
  cancelled: ['Cancelled', '#f87171'],
  unpaid: ['Trial ended — subscribe to continue billing', '#fbbf24'],
};

const INVOICE_STATUS: Record<string, string> = {
  no_overage: 'Within plan', trial: 'Free trial', billed: 'Added to next invoice',
  unbilled: 'Not charged (no active subscription)', failed: 'Failed — retried daily',
};

function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Razorpay Checkout'));
    document.body.appendChild(s);
  });
}

function GstLines({ g, rateBps }: { g: Gst; rateBps: number }) {
  const pct = rateBps / 100;
  return (
    <>
      {g.igst > 0 && <div style={muted}>IGST {pct}%: {inr(g.igst)}</div>}
      {g.cgst > 0 && <div style={muted}>CGST {pct / 2}%: {inr(g.cgst)} · SGST {pct / 2}%: {inr(g.sgst)}</div>}
    </>
  );
}

export default function Billing({ sector, base, adminKey }: Props) {
  const [data, setData] = useState<Summary | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<Record<string, string>>({});

  const headers = { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' };
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) throw new Error(json.error ?? `Request failed (${res.status})`);
    return json.data;
  };

  const load = async () => {
    try {
      const d: Summary = await call(`/billing/${encodeURIComponent(sector)}`);
      setData(d);
      const a = d.account;
      setDetails({
        legalName: a?.legalName ?? '', gstin: a?.gstin ?? '', billingEmail: a?.billingEmail ?? '',
        addressLine1: a?.addressLine1 ?? '', addressLine2: a?.addressLine2 ?? '', city: a?.city ?? '',
        state: a?.state ?? '', postalCode: a?.postalCode ?? '',
      });
      if (d.cost) call('/admin/billing/plans').then(setPlans).catch(() => {});
    } catch (e: any) {
      setMsg({ text: e.message === 'Admin key required' ? 'Enter the admin key (top right) to see billing.' : e.message, ok: false });
    }
  };

  useEffect(() => {
    setData(null); setMsg(null);
    if (!adminKey) { setMsg({ text: 'Enter the admin key (top right) to see billing.', ok: false }); return; }
    if (sector) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey, base, sector]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg({ text: ok, ok: true }); await load(); }
    catch (e: any) { setMsg({ text: e.message, ok: false }); }
    finally { setBusy(false); }
  };

  const subscribe = () => run(async () => {
    const { subscriptionId, keyId } = await call(`/billing/${encodeURIComponent(sector)}/subscribe`, { method: 'POST' });
    await loadCheckout();
    await new Promise<void>((resolve, reject) => {
      const rzp = new window.Razorpay!({
        key: keyId,
        subscription_id: subscriptionId,
        name: 'Avery AI receptionist',
        description: data?.plan ? `${data.plan.name} plan — ${inr(data.plan.monthly.totalPaise)}/month incl. GST` : undefined,
        prefill: { email: data?.account?.billingEmail ?? undefined },
        notes: { business_type: sector },
        theme: { color: '#6c47ff' },
        handler: (r: Record<string, string>) => {
          call(`/billing/${encodeURIComponent(sector)}/confirm`, { method: 'POST', body: JSON.stringify(r) })
            .then(() => resolve(), reject);
        },
        modal: { ondismiss: () => reject(new Error('Checkout closed')) },
      });
      rzp.on('payment.failed', (r: any) => reject(new Error(r?.error?.description ?? 'Payment failed')));
      rzp.open();
    });
  }, 'Subscription set up. Razorpay will confirm it shortly.');

  const saveDetails = () => run(() => call(`/billing/${encodeURIComponent(sector)}/details`, {
    method: 'PUT', body: JSON.stringify(details),
  }), 'Billing details saved.');

  const setPlan = (planId: string | null) => run(() => call(`/admin/billing/accounts/${encodeURIComponent(sector)}`, {
    method: 'PUT', body: JSON.stringify({ planId }),
  }), planId ? 'Plan assigned.' : 'Billing turned off for this business.');

  const syncPlan = (id: string) => run(() => call(`/admin/billing/plans/${encodeURIComponent(id)}/razorpay`, { method: 'POST' }),
    'Plan created in Razorpay.');

  if (!data) return <div style={card}>{msg ? <span style={{ color: '#f87171' }}>{msg.text}</span> : <span style={muted}>Loading…</span>}</div>;

  const { plan, usage, account } = data;
  const [stateLabel, stateColor] = STATE_LABEL[data.state];
  const pct = plan && plan.includedMinutes ? Math.min(100, (usage.minutes / plan.includedMinutes) * 100) : 0;
  const canSubscribe = plan && ['trialing', 'unpaid', 'cancelled', 'past_due'].includes(data.state);
  const field = (k: string, label: string, placeholder = '') => (
    <label style={{ display: 'grid', gap: 4, fontSize: 13, color: '#aaa' }}>
      {label}
      <input style={input} value={details[k] ?? ''} placeholder={placeholder}
        onChange={e => setDetails(d => ({ ...d, [k]: e.target.value }))} />
    </label>
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {msg && <div style={{ ...card, color: msg.ok ? '#4ade80' : '#f87171', padding: 12 }}>{msg.text}</div>}

      {/* Plan & status */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 16, color: '#fff' }}>{plan ? `${plan.name} plan` : 'No plan'}</h2>
          <span style={{ color: stateColor, fontSize: 13 }}>● {stateLabel}</span>
          {data.state === 'trialing' && account?.trialEndsAt && (
            <span style={muted}>until {new Date(account.trialEndsAt * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          )}
          {canSubscribe && (
            <button style={{ ...btn, marginLeft: 'auto', opacity: busy || !plan!.checkoutReady || !data.razorpayConfigured ? 0.5 : 1 }}
              disabled={busy || !plan!.checkoutReady || !data.razorpayConfigured}
              title={!data.razorpayConfigured ? 'Razorpay keys are not set on the server' : !plan!.checkoutReady ? 'The plan has not been created in Razorpay yet' : ''}
              onClick={subscribe}>
              {data.state === 'past_due' ? 'Update payment' : 'Subscribe with Razorpay'}
            </button>
          )}
        </div>
        {plan ? (
          <div style={{ marginTop: 12, display: 'grid', gap: 2 }}>
            <div style={{ fontSize: 22, color: '#fff', fontWeight: 600 }}>{inr(plan.monthly.totalPaise)}<span style={muted}> / month incl. GST</span></div>
            <div style={muted}>{inr(plan.monthly.amountPaise)} + {plan.gstRateBps / 100}% GST ({inr(plan.monthly.gstPaise)})</div>
            <GstLines g={plan.monthly} rateBps={plan.gstRateBps} />
            <div style={muted}>{plan.includedMinutes} minutes included, then {inr(plan.overagePaisePerMinute)}/minute + GST. UPI AutoPay or card.</div>
          </div>
        ) : (
          <p style={muted}>Billing is off for this business: calls are not charged.</p>
        )}
      </div>

      {/* Usage */}
      <div style={card}>
        <h3 style={{ margin: '0 0 12px', fontSize: 14, color: '#fff' }}>This month ({usage.period})</h3>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <div><div style={{ fontSize: 24, color: '#fff', fontWeight: 600 }}>{usage.minutes}{plan ? <span style={muted}> / {plan.includedMinutes} min</span> : <span style={muted}> min</span>}</div><div style={muted}>call minutes</div></div>
          <div><div style={{ fontSize: 24, color: '#fff', fontWeight: 600 }}>{usage.calls}</div><div style={muted}>calls</div></div>
          <div><div style={{ fontSize: 24, color: '#fff', fontWeight: 600 }}>{usage.whatsappConversations}</div><div style={muted}>WhatsApp conversations</div></div>
        </div>
        {plan && (
          <>
            <div style={{ height: 8, background: '#1e1e2e', borderRadius: 4, marginTop: 14, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: usage.alertLevel === 100 ? '#f87171' : usage.alertLevel === 80 ? '#fbbf24' : '#6c47ff' }} />
            </div>
            <p style={{ ...muted, marginBottom: 0 }}>
              Calls are never cut off. The owner is emailed at 80% and 100% of the included minutes.
              {usage.overageSoFar && usage.overageSoFar.minutes > 0 &&
                ` Extra so far: ${usage.overageSoFar.minutes} min = ${inr(usage.overageSoFar.amountPaise)} + GST ${inr(usage.overageSoFar.gstPaise)} = ${inr(usage.overageSoFar.totalPaise)}, billed at month end.`}
            </p>
          </>
        )}
      </div>

      {/* Operator only: cost and margin */}
      {data.cost && (
        <div style={{ ...card, borderColor: '#6c47ff44' }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 14, color: '#fff' }}>Cost & margin <span style={{ ...muted, fontWeight: 400 }}>(operator only)</span></h3>
          <p style={{ ...muted, marginTop: 0 }}>Estimated provider cost (telephony, STT, TTS, model tokens) at ₹{data.cost.usdToInr}/USD. Revenue excludes GST.</p>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              <tr><td style={td}>Provider cost this month</td><td style={td}>{inr(data.cost.costPaise)}</td><td style={td}>{data.cost.costPerMinutePaise != null ? `${inr(data.cost.costPerMinutePaise)}/min` : '—'}</td></tr>
              <tr><td style={td}>Revenue (if the month ended now)</td><td style={td}>{inr(data.cost.revenuePaise)}</td><td style={td}>{data.cost.revenuePerMinutePaise != null ? `${inr(data.cost.revenuePerMinutePaise)}/min` : '—'}</td></tr>
              <tr><td style={td}>Margin</td><td style={{ ...td, color: (data.cost.marginPaise ?? 0) < 0 ? '#f87171' : '#4ade80' }}>{data.cost.marginPaise != null ? inr(data.cost.marginPaise) : '— (no plan)'}</td><td style={td} /></tr>
              {data.cost.testCalls > 0 && <tr><td style={td} colSpan={3}><span style={muted}>Includes {data.cost.testCalls} synthetic test call(s), costed but not billed.</span></td></tr>}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            <span style={muted}>Plan for this business:</span>
            <select style={{ ...input, width: 'auto' }} value={plan?.id ?? ''} disabled={busy}
              onChange={e => setPlan(e.target.value || null)}>
              <option value="">Billing off</option>
              {plans.filter(p => p.isActive || p.id === plan?.id).map(p => (
                <option key={p.id} value={p.id}>{p.name} — {inr(p.monthlyFeePaise)} + GST, {p.includedMinutes} min</option>
              ))}
            </select>
            {plan && !plan.checkoutReady && (
              <button style={{ ...ghost, opacity: busy || !data.razorpayConfigured ? 0.5 : 1 }}
                title={data.razorpayConfigured ? '' : 'Razorpay keys are not set on the server'}
                disabled={busy || !data.razorpayConfigured} onClick={() => syncPlan(plan.id)}>Create plan in Razorpay</button>
            )}
          </div>
        </div>
      )}

      {/* GST details */}
      <div style={card}>
        <h3 style={{ margin: '0 0 12px', fontSize: 14, color: '#fff' }}>Billing details (GST)</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {field('legalName', 'Legal name')}
          {field('gstin', 'GSTIN (optional)', '27AAPFU0939F1ZV')}
          {field('billingEmail', 'Billing email', 'Defaults to the notification email')}
          {field('addressLine1', 'Address line 1')}
          {field('addressLine2', 'Address line 2')}
          {field('city', 'City')}
          {field('state', 'State')}
          {field('postalCode', 'PIN code')}
        </div>
        <button style={{ ...btn, marginTop: 14 }} disabled={busy} onClick={saveDetails}>Save details</button>
      </div>

      {/* Invoices */}
      <div style={card}>
        <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#fff' }}>Extra-minute invoices</h3>
        {data.supplierGstin && <p style={{ ...muted, marginTop: 0 }}>Supplier GSTIN {data.supplierGstin}{account?.gstin ? ` · Your GSTIN ${account.gstin}` : ''}</p>}
        {data.invoices.length === 0 ? <p style={muted}>No closed months yet. The monthly plan fee is invoiced by Razorpay.</p> : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>
              <th style={th}>Month</th><th style={th}>Minutes</th><th style={th}>Extra</th><th style={th}>Amount</th>
              <th style={th}>GST</th><th style={th}>Total</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {data.invoices.map(i => (
                <tr key={i.period}>
                  <td style={td}>{i.period}</td>
                  <td style={td}>{i.minutesUsed} / {i.includedMinutes}</td>
                  <td style={td}>{i.overageMinutes} min</td>
                  <td style={td}>{inr(i.amountPaise)}</td>
                  <td style={td}>{i.cgst > 0 ? `CGST ${inr(i.cgst)} + SGST ${inr(i.sgst)}` : `IGST ${inr(i.igst)}`}</td>
                  <td style={td}>{inr(i.totalPaise)}</td>
                  <td style={td}>{INVOICE_STATUS[i.status] ?? i.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
