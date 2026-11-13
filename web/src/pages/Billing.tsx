import { useEffect, useState } from 'react';
import { Badge, Button, Card, Notice, Status, Table } from '../components/ui';
import CallCosts from '../components/CallCosts';

// Billing tab: plan, minutes this month, GST-inclusive amounts, invoices and
// the Razorpay Checkout button. Cost and margin come back from the API only
// for the operator (today: anyone with the admin key), so an owner login will
// see the same page without them.

// auth: the admin key or the signed-in owner's token (App's authHeaders).
interface Props { sector: string; base: string; auth: Record<string, string> }

interface Gst { amountPaise: number; gstPaise: number; totalPaise: number; cgst: number; sgst: number; igst: number }
interface TaxInvoice { id: string; number: string; issuedAt: number; taxablePaise: number; cgst: number; sgst: number; igst: number; totalPaise: number; refundedPaise: number }
interface OwnerPlan { id: string; name: string; monthlyFeePaise: number; includedMinutes: number; overagePaisePerMinute: number; gstRateBps: number; checkoutReady: boolean }
interface Summary {
  state: 'off' | 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'unpaid';
  nextAction: 'subscribe' | 'update_payment' | 'upgrade' | null;
  trialDaysLeft: number | null;
  nextCharge: { at: number; amountPaise: number } | null;
  payment: null | { lastStatus: string | null; lastAt: number | null; lastError: string | null; pastDueSince: number | null; graceEndsAt: number | null };
  overageAllowed: boolean;
  cancelAtPeriodEnd: boolean;
  pendingPlan: { id: string; name: string } | null;
  upgradeTo: { id: string; name: string } | null;
  taxInvoices: TaxInvoice[];
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
interface Plan { id: string; name: string; monthlyFeePaise: number; includedMinutes: number; overagePaisePerMinute: number; razorpayPlanId: string | null; isActive: boolean; isDefault?: boolean; trialDays: number; gstRateBps: number; currency: string }

declare global {
  interface Window { Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (e: string, cb: (r: any) => void) => void } }
}

export const inr = (paise: number) =>
  '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATE_LABEL: Record<Summary['state'], [string, 'success' | 'warning' | 'danger' | undefined]> = {
  off: ['Billing off', undefined],
  trialing: ['Free trial', 'success'],
  active: ['Subscribed', 'success'],
  past_due: ['Payment failed', 'danger'],
  paused: ['Paused', 'warning'],
  cancelled: ['Cancelled', 'danger'],
  unpaid: ['Trial ended — subscribe to continue billing', 'warning'],
};

const INVOICE_STATUS: Record<string, string> = {
  no_overage: 'Within plan', trial: 'Free trial', billed: 'Added to next invoice',
  unbilled: 'Not charged (no active subscription)', failed: 'Failed — retried daily',
  deferred: 'Waiting for payment — retried daily', waived: 'Not charged (payment overdue)', billing: 'Being added…',
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

const day = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

// Razorpay Checkout draws in its own frame: it needs a real colour, not a CSS variable.
function accentHex(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : '#4f46e5';
}

function GstLines({ g, rateBps }: { g: Gst; rateBps: number }) {
  const pct = rateBps / 100;
  return (
    <>
      {g.igst > 0 && <p className="muted small">IGST {pct}%: {inr(g.igst)}</p>}
      {g.cgst > 0 && <p className="muted small">CGST {pct / 2}%: {inr(g.cgst)} · SGST {pct / 2}%: {inr(g.sgst)}</p>}
    </>
  );
}

export default function Billing({ sector, base, auth }: Props) {
  const [data, setData] = useState<Summary | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<Record<string, string>>({});
  const [ownerPlans, setOwnerPlans] = useState<OwnerPlan[]>([]);

  const headers = { ...auth, 'Content-Type': 'application/json' };
  const signedIn = Object.keys(auth).length > 0;
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
      if (d.plan) call(`/billing/${encodeURIComponent(sector)}/plans`).then(setOwnerPlans).catch(() => {});
    } catch (e: any) {
      setMsg({ text: e.message, ok: false });
    }
  };

  useEffect(() => {
    setData(null); setMsg(null);
    if (!signedIn) { setMsg({ text: 'Sign in (or enter the admin key) to see billing.', ok: false }); return; }
    if (sector) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, base, sector]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg({ text: ok, ok: true }); await load(); }
    catch (e: any) { setMsg({ text: e.message, ok: false }); }
    finally { setBusy(false); }
  };

  // Razorpay Checkout: success → the server verifies the signature; failure
  // shows Razorpay's reason; closing it charges nothing.
  const subscribe = () => run(async () => {
    const start = await call(`/billing/${encodeURIComponent(sector)}/subscribe`, { method: 'POST' });
    await loadCheckout();
    const outcome = await new Promise<'paid' | 'closed'>((resolve, reject) => {
      const rzp = new window.Razorpay!({
        key: start.keyId,
        subscription_id: start.subscriptionId,
        name: 'Avery AI receptionist',
        description: start.description,
        prefill: start.prefill,
        notes: { business_type: sector },
        theme: { color: accentHex() },
        handler: (r: Record<string, string>) => {
          call(`/billing/${encodeURIComponent(sector)}/confirm`, { method: 'POST', body: JSON.stringify(r) })
            .then(() => resolve('paid'), reject);
        },
        modal: { ondismiss: () => resolve('closed') },
      });
      rzp.on('payment.failed', (r: any) => reject(new Error(`Payment failed: ${r?.error?.description ?? 'please try another method'}`)));
      rzp.open();
    });
    if (outcome === 'closed') throw new Error('Checkout closed. Nothing was charged.');
  }, 'Subscribed. Razorpay will confirm the payment shortly.');

  const updatePayment = () => run(async () => {
    const r = await call(`/billing/${encodeURIComponent(sector)}/update-payment`, { method: 'POST' });
    if (!r.url) throw new Error('Razorpay has no payment page for this subscription: use Subscribe to set up payment again.');
    window.open(r.url, '_blank', 'noopener');
  }, 'Razorpay\'s payment page opened in a new tab. This page updates once the payment goes through.');

  const changePlan = (p: OwnerPlan) => run(async () => {
    const r = await call(`/billing/${encodeURIComponent(sector)}/change-plan`, { method: 'POST', body: JSON.stringify({ planId: p.id }) });
    setMsg({ ok: true, text: r.needsCheckout ? `Switched to ${p.name}. Subscribe again to set up payment for the new amount.`
      : r.effective === 'cycle_end' ? `You'll move to ${p.name} at the end of this billing period.` : `You're now on ${p.name}.` });
  });

  const cancel = () => {
    if (!window.confirm('Cancel your subscription? It stays active until the end of the period you have paid for. Your assistant keeps answering calls until then.')) return;
    return run(() => call(`/billing/${encodeURIComponent(sector)}/cancel`, { method: 'POST' }), 'Subscription cancelled at the end of this period.');
  };

  const openInvoice = (id: string) => run(async () => {
    const res = await fetch(`${base}/billing/${encodeURIComponent(sector)}/invoices/${encodeURIComponent(id)}`, { headers: auth });
    if (!res.ok) throw new Error('Could not open the invoice');
    const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });

  const saveDetails = () => run(() => call(`/billing/${encodeURIComponent(sector)}/details`, {
    method: 'PUT', body: JSON.stringify(details),
  }), 'Billing details saved.');

  const setPlan = (planId: string | null) => run(() => call(`/admin/billing/accounts/${encodeURIComponent(sector)}`, {
    method: 'PUT', body: JSON.stringify({ planId }),
  }), planId ? 'Plan assigned.' : 'Billing turned off for this business.');

  // The plan (and its free trial) every new business starts on; none = billing off for new businesses.
  const setDefaultPlan = (id: string) => {
    const target = plans.find(p => p.id === (id || plans.find(x => x.isDefault)?.id));
    if (!target) return;
    const { name, currency, monthlyFeePaise, includedMinutes, overagePaisePerMinute, trialDays, gstRateBps, isActive } = target;
    return run(() => call(`/admin/billing/plans/${encodeURIComponent(target.id)}`, {
      method: 'PUT', body: JSON.stringify({ name, currency, monthlyFeePaise, includedMinutes, overagePaisePerMinute, trialDays, gstRateBps, isActive, isDefault: !!id }),
    }).then(() => call('/admin/billing/plans').then(setPlans)), id ? `New businesses now start on ${target.name} (free trial first).` : 'New businesses start with billing off.');
  };

  const syncPlan = (id: string) => run(() => call(`/admin/billing/plans/${encodeURIComponent(id)}/razorpay`, { method: 'POST' }),
    'Plan created in Razorpay.');

  if (!data) return msg ? <Notice tone="error">{msg.text}</Notice> : <p className="muted" role="status">Loading…</p>;

  const { plan, usage, account } = data;
  const [stateLabel, stateTone] = STATE_LABEL[data.state];
  const pct = plan && plan.includedMinutes ? Math.min(100, (usage.minutes / plan.includedMinutes) * 100) : 0;
  const action = data.nextAction;
  const field = (k: string, label: string, placeholder = '') => (
    <div className="field">
      <label htmlFor={`bill-${k}`}>{label}</label>
      <input id={`bill-${k}`} className="input" value={details[k] ?? ''} placeholder={placeholder}
        onChange={e => setDetails(d => ({ ...d, [k]: e.target.value }))} />
    </div>
  );
  const checkoutBlocked = !data.razorpayConfigured ? 'Online payment isn\'t switched on for this service yet (Razorpay keys).' : plan && !plan.checkoutReady ? 'This plan hasn\'t been set up in Razorpay yet.' : '';
  const pay = data.payment;
  const statusLine =
    data.state === 'trialing' && account?.trialEndsAt ? `Free trial: ${data.trialDaysLeft} day${data.trialDaysLeft === 1 ? '' : 's'} left (until ${day(account.trialEndsAt)}). Nothing is charged before then.`
    : data.state === 'past_due' ? `We couldn't collect your payment${pay?.lastError ? ` (${pay.lastError})` : ''}. Your assistant keeps answering every call.${pay?.graceEndsAt && data.overageAllowed ? ` Please update payment before ${day(pay.graceEndsAt)}; after that, minutes beyond your plan are paused.` : ' Minutes beyond your plan are paused until payment goes through.'}`
    : data.state === 'unpaid' ? 'Your free trial has ended. Subscribe to keep your plan.'
    : data.cancelAtPeriodEnd && account?.currentPeriodEnd ? `Cancelled: active until ${day(account.currentPeriodEnd)}.`
    : data.state === 'cancelled' ? 'Your subscription has ended. Subscribe again any time.'
    : undefined;
  const actionButton =
    action === 'subscribe' ? <Button disabled={busy || !!checkoutBlocked} title={checkoutBlocked} onClick={subscribe}>Subscribe</Button>
    : action === 'update_payment' ? <Button disabled={busy} onClick={updatePayment}>Update payment</Button>
    : action === 'upgrade' && data.upgradeTo ? <Button disabled={busy} onClick={() => { const p = ownerPlans.find(x => x.id === data.upgradeTo!.id); if (p) changePlan(p); }}>Upgrade to {data.upgradeTo.name}</Button>
    : null;
  const subscribed = ['active', 'past_due'].includes(data.state);

  return (
    <>
      <Status msg={msg} />

      <Card
        title={<>{plan ? `${plan.name} plan` : 'No plan'} <Badge tone={stateTone}>{data.cancelAtPeriodEnd && data.state === 'active' ? 'Cancels at period end' : stateLabel}</Badge></>}
        description={statusLine}
        actions={actionButton}
      >
        {plan ? (
          <div className="stack-sm">
            <p><span className="price">{inr(plan.monthly.totalPaise)}</span> <span className="muted">/ month incl. GST</span></p>
            <p className="muted small">{inr(plan.monthly.amountPaise)} + {plan.gstRateBps / 100}% GST ({inr(plan.monthly.gstPaise)})</p>
            <GstLines g={plan.monthly} rateBps={plan.gstRateBps} />
            <p className="muted small">{plan.includedMinutes} minutes included, then {inr(plan.overagePaisePerMinute)}/minute + GST. UPI AutoPay or card.</p>
            <dl className="kv">
              <dt>Next charge</dt>
              <dd>{data.nextCharge ? `${inr(data.nextCharge.amountPaise)} on ${day(data.nextCharge.at)}${data.pendingPlan ? ` (${data.pendingPlan.name})` : ''}, plus any extra minutes` : '—'}</dd>
              <dt>Last payment</dt>
              <dd>{pay?.lastStatus === 'failed' ? <Badge tone="danger">Failed</Badge> : pay?.lastStatus === 'captured' ? <Badge tone="success">Paid</Badge> : '—'}{pay?.lastAt ? ` ${day(pay.lastAt)}` : ''}</dd>
              {data.pendingPlan && <><dt>Plan change</dt><dd>Moves to {data.pendingPlan.name} at the end of this period</dd></>}
            </dl>
            {action === 'subscribe' && checkoutBlocked && <p className="muted small">{checkoutBlocked}</p>}
          </div>
        ) : (
          <p className="muted">Billing is off for this business: calls are not charged.</p>
        )}
      </Card>

      <Card title={`This month (${usage.period})`}>
        <div className="figures">
          <div><span className="figure">{usage.minutes}</span><span className="muted">{plan ? ` / ${plan.includedMinutes} min` : ' min'}</span><p className="muted small">call minutes</p></div>
          <div><span className="figure">{usage.calls}</span><p className="muted small">calls</p></div>
          <div><span className="figure">{usage.whatsappConversations}</span><p className="muted small">WhatsApp conversations</p></div>
        </div>
        {plan && (
          <>
            <div className={`progress usage-${usage.alertLevel}`} aria-label={`${Math.round(pct)}% of included minutes used`} role="img">
              <div style={{ width: `${pct}%` }} />
            </div>
            <p className="muted small">
              Calls are never cut off. The owner is emailed at 80% and 100% of the included minutes.
              {usage.overageSoFar && usage.overageSoFar.minutes > 0 &&
                ` Extra so far: ${usage.overageSoFar.minutes} min = ${inr(usage.overageSoFar.amountPaise)} + GST ${inr(usage.overageSoFar.gstPaise)} = ${inr(usage.overageSoFar.totalPaise)}, billed at month end.`}
            </p>
          </>
        )}
      </Card>

      {/* Operator only: cost and margin */}
      {data.cost && (
        <Card className="card-accent" title={<>Cost &amp; margin <Badge tone="accent">Operator only</Badge></>}
          description={`Estimated provider cost (phone lines, speech recognition, voice, AI model) at ₹${data.cost.usdToInr}/USD. Revenue excludes GST.`}>
          <Table head={['', 'This month', 'Per minute']} cards={false}>
            <tr><td>Provider cost</td><td>{inr(data.cost.costPaise)}</td><td>{data.cost.costPerMinutePaise != null ? inr(data.cost.costPerMinutePaise) : '—'}</td></tr>
            <tr><td>Revenue (if the month ended now)</td><td>{inr(data.cost.revenuePaise)}</td><td>{data.cost.revenuePerMinutePaise != null ? inr(data.cost.revenuePerMinutePaise) : '—'}</td></tr>
            <tr><td>Margin</td><td className={(data.cost.marginPaise ?? 0) < 0 ? 'bad' : 'ok'}>{data.cost.marginPaise != null ? inr(data.cost.marginPaise) : '— (no plan)'}</td><td /></tr>
          </Table>
          {data.cost.testCalls > 0 && <p className="muted small">Includes {data.cost.testCalls} synthetic test call(s), costed but not billed.</p>}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="bill-plan">Plan for this business</label>
              <select id="bill-plan" className="input" value={plan?.id ?? ''} disabled={busy} onChange={e => setPlan(e.target.value || null)}>
                <option value="">Billing off</option>
                {plans.filter(p => p.isActive || p.id === plan?.id).map(p => (
                  <option key={p.id} value={p.id}>{p.name} — {inr(p.monthlyFeePaise)} + GST, {p.includedMinutes} min</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="bill-default">New businesses start on</label>
              <select id="bill-default" className="input" value={plans.find(p => p.isDefault)?.id ?? ''} disabled={busy} onChange={e => setDefaultPlan(e.target.value)}>
                <option value="">Billing off</option>
                {plans.filter(p => p.isActive).map(p => <option key={p.id} value={p.id}>{p.name}{p.trialDays ? ` (${p.trialDays}-day trial)` : ''}</option>)}
              </select>
            </div>
          </div>
          {plan && !plan.checkoutReady && (
            <div className="form-actions">
              <Button variant="secondary" title={data.razorpayConfigured ? '' : 'Razorpay keys are not set on the server'}
                disabled={busy || !data.razorpayConfigured} onClick={() => syncPlan(plan.id)}>Create plan in Razorpay</Button>
            </div>
          )}
        </Card>
      )}

      {data.cost && <CallCosts base={base} auth={auth} sector={sector} />}

      {plan && ownerPlans.length > 1 && (
        <Card title="Change plan" description={subscribed ? 'Upgrades start now (Razorpay charges the difference). Downgrades start at the end of this billing period.' : 'Pick the plan you want before you subscribe.'}>
          <div className="plan-grid">
            {ownerPlans.map(p => {
              const current = p.id === plan.id && !data.pendingPlan;
              return (
                <div key={p.id} className={`plan-option${p.id === plan.id ? ' current' : ''}`}>
                  <p className="strong">{p.name}</p>
                  <p><span className="price">{inr(Math.round(p.monthlyFeePaise * (1 + p.gstRateBps / 10_000)))}</span> <span className="muted small">/ month incl. GST</span></p>
                  <p className="muted small">{p.includedMinutes} min included · then {inr(p.overagePaisePerMinute)}/min + GST</p>
                  {current ? <Badge tone="accent">Current plan</Badge>
                    : <Button variant="secondary" size="sm" disabled={busy || (subscribed && !p.checkoutReady)} onClick={() => changePlan(p)}>
                        {p.id === plan.id ? 'Keep this plan' : p.monthlyFeePaise > (ownerPlans.find(x => x.id === plan.id)?.monthlyFeePaise ?? 0) ? 'Upgrade' : 'Downgrade'}
                      </Button>}
                </div>
              );
            })}
          </div>
          {subscribed && !data.cancelAtPeriodEnd && (
            <div className="form-actions"><Button variant="secondary" disabled={busy} onClick={cancel}>Cancel subscription</Button></div>
          )}
        </Card>
      )}
      {plan && ownerPlans.length <= 1 && subscribed && !data.cancelAtPeriodEnd && (
        <Card title="Subscription">
          <div className="form-actions"><Button variant="secondary" disabled={busy} onClick={cancel}>Cancel subscription</Button></div>
        </Card>
      )}

      <Card title="Invoices" description={data.supplierGstin ? `GST tax invoices for each payment. Supplier GSTIN ${data.supplierGstin}${account?.gstin ? ` · Your GSTIN ${account.gstin}` : ''}` : 'GST tax invoices for each payment.'}>
        {data.taxInvoices.length === 0 ? <p className="muted">No payments yet. An invoice appears here (and is emailed) after each payment.</p> : (
          <Table head={['Invoice', 'Date', 'Taxable', 'GST', 'Total', '']}>
            {data.taxInvoices.map(t => (
              <tr key={t.id}>
                <td data-label="Invoice">{t.number}</td>
                <td data-label="Date">{day(t.issuedAt)}</td>
                <td data-label="Taxable">{inr(t.taxablePaise)}</td>
                <td data-label="GST">{t.igst > 0 ? `IGST ${inr(t.igst)}` : `CGST ${inr(t.cgst)} + SGST ${inr(t.sgst)}`}</td>
                <td data-label="Total">{inr(t.totalPaise)}{t.refundedPaise > 0 && <span className="muted small"> (refunded {inr(t.refundedPaise)})</span>}</td>
                <td data-label=""><Button variant="secondary" size="sm" disabled={busy} onClick={() => openInvoice(t.id)}>Download</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Billing details (GST)" description="Shown on your invoices.">
        <div className="form-grid">
          {field('legalName', 'Legal name')}
          {field('gstin', 'GSTIN (optional)', '27AAPFU0939F1ZV')}
          {field('billingEmail', 'Billing email', 'Defaults to the notification email')}
          {field('addressLine1', 'Address line 1')}
          {field('addressLine2', 'Address line 2')}
          {field('city', 'City')}
          {field('state', 'State')}
          {field('postalCode', 'PIN code')}
        </div>
        <div className="form-actions"><Button busy={busy} onClick={saveDetails}>Save details</Button></div>
      </Card>

      <Card title="Extra minutes by month" description="Minutes beyond your plan are added to the next payment (and its invoice).">
        {data.invoices.length === 0 ? <p className="muted">No closed months yet.</p> : (
          <Table head={['Month', 'Minutes', 'Extra', 'Amount', 'GST', 'Total', 'Status']}>
            {data.invoices.map(i => (
              <tr key={i.period}>
                <td data-label="Month">{i.period}</td>
                <td data-label="Minutes">{i.minutesUsed} / {i.includedMinutes}</td>
                <td data-label="Extra">{i.overageMinutes} min</td>
                <td data-label="Amount">{inr(i.amountPaise)}</td>
                <td data-label="GST">{i.cgst > 0 ? `CGST ${inr(i.cgst)} + SGST ${inr(i.sgst)}` : `IGST ${inr(i.igst)}`}</td>
                <td data-label="Total">{inr(i.totalPaise)}</td>
                <td data-label="Status">{INVOICE_STATUS[i.status] ?? i.status}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
