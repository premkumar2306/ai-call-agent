import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { taxInvoices } from '../../db/schema';
import type { Env } from '../../types';
import { getSector } from '../sector.service';
import { sendEmail } from '../notify.service';
import { financialYear, formatInr, formatInvoiceNumber, gstinStateCode, invoiceTotals, type InvoiceLine } from './pricing';
import type { RazorpayInvoice } from './razorpay';
import type { Account, Plan } from './service';

// GST tax invoices: one per payment Razorpay collects (the monthly fee plus
// any extra-minute add-ons on that charge). Razorpay charges GST-inclusive
// amounts, so the taxable value is backed out of what was paid. Numbers run
// AVY/<FY>/000001… per Indian financial year with no gaps (invoice_counters).
// CGST+SGST when the customer's GSTIN is in the supplier's state, else IGST.

export type TaxInvoice = typeof taxInvoices.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);

async function nextInvoiceNumber(env: Env, at: Date): Promise<string> {
  const fy = financialYear(at);
  const row = await env.DB.prepare(
    'INSERT INTO invoice_counters (fy, last) VALUES (?, 1) ON CONFLICT(fy) DO UPDATE SET last = last + 1 RETURNING last',
  ).bind(fy).first<{ last: number }>();
  return formatInvoiceNumber(fy, Number(row!.last));
}

/** A Razorpay invoice line's charged amount (GST-inclusive, paise). */
function lineTotal(li: NonNullable<RazorpayInvoice['line_items']>[number]): number {
  if (typeof li.net_amount === 'number') return li.net_amount;
  return (li.unit_amount ?? li.amount ?? 0) * (li.quantity ?? 1);
}

const istDate = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Issues (once per Razorpay invoice) and emails the tax invoice for a paid
 * Razorpay invoice. Returns the existing one on a repeat.
 */
export async function issueTaxInvoice(env: Env, account: Account, plan: Plan | null, inv: RazorpayInvoice, paymentId: string | null): Promise<TaxInvoice> {
  const db = getDb(env.DB);
  const [existing] = await db.select().from(taxInvoices).where(eq(taxInvoices.razorpayInvoiceId, inv.id));
  if (existing) return existing;

  const rate = plan?.gstRateBps ?? 1800;
  const period = inv.billing_start && inv.billing_end ? ` (${istDate(inv.billing_start)} – ${istDate(inv.billing_end)})` : '';
  let charged = (inv.line_items ?? []).map(li => ({
    description: li.type === 'plan' || (!li.type && li.name === plan?.name) ? `${plan?.name ?? li.name ?? 'Plan'} plan${period}` : (li.name || li.description || 'Charge'),
    totalPaise: lineTotal(li),
  })).filter(l => l.totalPaise > 0);
  const paid = inv.amount_paid ?? inv.amount ?? 0;
  if (!charged.length || (paid && charged.reduce((s, l) => s + l.totalPaise, 0) !== paid)) {
    charged = [{ description: `${plan?.name ?? 'Avery'} plan${period}`, totalPaise: paid }];
  }
  const supplierState = gstinStateCode(env.BILLING_SUPPLIER_GSTIN);
  const customerState = gstinStateCode(account.gstin);
  const t = invoiceTotals(charged, rate, supplierState, customerState);
  const issuedAt = inv.paid_at ?? nowSec();
  const sector = await getSector(env, account.businessType);
  const customer = {
    name: account.legalName || sector?.name || account.businessType,
    address: [account.addressLine1, account.addressLine2, account.city, account.state, account.postalCode].filter(Boolean).join(', '),
  };
  const id = crypto.randomUUID();
  await db.insert(taxInvoices).values({
    id, invoiceNumber: await nextInvoiceNumber(env, new Date(issuedAt * 1000)), businessType: account.businessType,
    razorpayInvoiceId: inv.id, razorpayPaymentId: paymentId ?? inv.payment_id ?? null, issuedAt,
    periodStart: inv.billing_start ?? null, periodEnd: inv.billing_end ?? null,
    linesJson: JSON.stringify(t.lines), taxablePaise: t.taxablePaise, cgstPaise: t.cgst, sgstPaise: t.sgst, igstPaise: t.igst,
    totalPaise: t.totalPaise, gstRateBps: rate, supplierGstin: env.BILLING_SUPPLIER_GSTIN ?? null, customerGstin: account.gstin ?? null,
    customerJson: JSON.stringify(customer), placeOfSupply: customerState ?? supplierState, createdAt: nowSec(),
  }).onConflictDoNothing();
  const [row] = await db.select().from(taxInvoices).where(eq(taxInvoices.razorpayInvoiceId, inv.id));

  const to = account.billingEmail || sector?.notifyEmail;
  if (to && row && !row.emailedAt) {
    try {
      await sendEmail(env, to, `Tax invoice ${row.invoiceNumber}: ${formatInr(row.totalPaise)} paid`,
        `Thank you. We received ${formatInr(row.totalPaise)} for your Avery AI receptionist.\n\n` +
        `Invoice ${row.invoiceNumber}, ${istDate(row.issuedAt)}.\n` +
        `Taxable value ${formatInr(row.taxablePaise)}; GST ${formatInr(row.totalPaise - row.taxablePaise)}.\n\n` +
        `You can also download it from Settings → Billing.\n`,
        renderInvoiceHtml(env, row));
      await db.update(taxInvoices).set({ emailedAt: nowSec() }).where(eq(taxInvoices.id, row.id));
    } catch (e: any) {
      console.error('[billing] invoice email failed', row.invoiceNumber, e?.message || e);
    }
  }
  return row!;
}

export async function listTaxInvoices(env: Env, businessType: string, limit = 24): Promise<TaxInvoice[]> {
  return getDb(env.DB).select().from(taxInvoices).where(eq(taxInvoices.businessType, businessType))
    .orderBy(desc(taxInvoices.issuedAt)).limit(limit);
}

export async function getTaxInvoice(env: Env, businessType: string, id: string): Promise<TaxInvoice | null> {
  const [row] = await getDb(env.DB).select().from(taxInvoices)
    .where(and(eq(taxInvoices.businessType, businessType), eq(taxInvoices.id, id)));
  return row ?? null;
}

/** Read-only: a refund made in the Razorpay Dashboard is shown against its invoice. */
export async function recordRefund(env: Env, paymentId: string, refundedTotalPaise: number): Promise<boolean> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(taxInvoices).where(eq(taxInvoices.razorpayPaymentId, paymentId));
  if (!row) return false;
  await db.update(taxInvoices).set({ refundedPaise: Math.min(row.totalPaise, refundedTotalPaise) }).where(eq(taxInvoices.id, row.id));
  return true;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A self-contained, printable tax invoice (the owner's "Download" and the email body). */
export function renderInvoiceHtml(env: Env, inv: TaxInvoice): string {
  const lines: InvoiceLine[] = JSON.parse(inv.linesJson);
  const customer = inv.customerJson ? JSON.parse(inv.customerJson) as { name?: string; address?: string } : {};
  const pct = inv.gstRateBps / 100;
  const sac = env.BILLING_SAC_CODE;
  const taxRows = inv.igstPaise > 0 || (inv.cgstPaise === 0 && inv.sgstPaise === 0)
    ? `<tr><td>IGST ${pct}%</td><td class="r">${formatInr(inv.igstPaise)}</td></tr>`
    : `<tr><td>CGST ${pct / 2}%</td><td class="r">${formatInr(inv.cgstPaise)}</td></tr><tr><td>SGST ${pct / 2}%</td><td class="r">${formatInr(inv.sgstPaise)}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tax invoice ${esc(inv.invoiceNumber)}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;background:#fff;margin:0;padding:24px}
.inv{max-width:720px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.muted{color:#555}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:20px 0}
table{width:100%;border-collapse:collapse;margin-top:12px}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}
.r{text-align:right}.total td{font-weight:700;border-top:2px solid #111}
@media (max-width:560px){.grid{grid-template-columns:1fr}}
@media print{body{padding:0}.noprint{display:none}}
</style></head><body><div class="inv">
<p class="noprint"><button onclick="window.print()">Print / save as PDF</button></p>
<h1>Tax invoice</h1>
<p class="muted">No. <strong>${esc(inv.invoiceNumber)}</strong> · ${esc(istDate(inv.issuedAt))}</p>
<div class="grid">
<div><strong>Supplier</strong><br>${esc(env.BILLING_SUPPLIER_NAME || 'Avery')}<br>${esc(env.BILLING_SUPPLIER_ADDRESS || '')}${inv.supplierGstin ? `<br>GSTIN ${esc(inv.supplierGstin)}` : ''}</div>
<div><strong>Billed to</strong><br>${esc(customer.name)}<br>${esc(customer.address)}${inv.customerGstin ? `<br>GSTIN ${esc(inv.customerGstin)}` : ''}${inv.placeOfSupply ? `<br>Place of supply: state ${esc(inv.placeOfSupply)}` : ''}</div>
</div>
<table><thead><tr><th>Description${sac ? ` (SAC ${esc(sac)})` : ''}</th><th class="r">Amount</th></tr></thead><tbody>
${lines.map(l => `<tr><td>${esc(l.description)}</td><td class="r">${formatInr(l.amountPaise)}</td></tr>`).join('\n')}
<tr><td>Taxable value</td><td class="r">${formatInr(inv.taxablePaise)}</td></tr>
${taxRows}
<tr class="total"><td>Total paid</td><td class="r">${formatInr(inv.totalPaise)}</td></tr>
${inv.refundedPaise > 0 ? `<tr><td>Refunded</td><td class="r">−${formatInr(inv.refundedPaise)}</td></tr>` : ''}
</tbody></table>
<p class="muted">Paid via Razorpay${inv.razorpayPaymentId ? ` (payment ${esc(inv.razorpayPaymentId)})` : ''}. Amounts in INR.</p>
</div></body></html>`;
}
