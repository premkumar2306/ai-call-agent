import { describe, expect, it, beforeEach } from 'vitest';
import type { Env, SectorMeta } from '../src/types';
import {
  DEFAULT_DISCLOSURE_TEXT, callStartNotice, disclosureEnabled, isIndianBusiness, noticeVersion,
  privacyLinkSuffix, recordConsent, validPrivacyUrl, whatsappNotice,
} from '../src/services/disclosure';
import {
  ERASED_ID, eraseSubjectData, exportSubjectData, isUpcomingActive, kvKeysFor, phoneDigits, resolveSubject,
} from '../src/services/data-rights.service';
import { applyRetention, retentionCutoffs, validRetentionDays } from '../src/services/retention.service';
import { parsePrivacySettings } from '../src/routes/privacy';
import { hashId } from '../src/utils/identity';
import { createTestD1, createTestKV } from './helpers/d1.mjs';

const US: SectorMeta = { name: 'Advanced VTech', model: 'service', categories: [], hours: {}, timezone: 'America/Chicago', currency: 'USD' };
const IN: SectorMeta = { name: 'Sharma Clinic', model: 'service', categories: [], hours: {}, timezone: 'Asia/Kolkata', currency: 'INR' };

describe('call-start disclosure', () => {
  it('is off for the existing US business and on for Indian businesses by default', () => {
    expect(disclosureEnabled(US)).toBe(false);
    expect(callStartNotice(US)).toBeNull();
    expect(disclosureEnabled(IN)).toBe(true);
    expect(callStartNotice(IN)).toBe(DEFAULT_DISCLOSURE_TEXT);
    expect(disclosureEnabled(null)).toBe(false);
  });
  it('detects India by country code, then timezone or currency', () => {
    expect(isIndianBusiness({ ...US, countryCode: 'IN' } as SectorMeta)).toBe(true);
    expect(isIndianBusiness({ ...IN, countryCode: 'US' } as SectorMeta)).toBe(false);
    expect(isIndianBusiness({ ...US, currency: 'INR' })).toBe(true);
    expect(isIndianBusiness({ ...US, timezone: 'Asia/Calcutta' })).toBe(true);
  });
  it('honours the explicit per-business setting either way', () => {
    expect(disclosureEnabled({ ...US, aiDisclosure: true })).toBe(true);
    expect(disclosureEnabled({ ...IN, aiDisclosure: false })).toBe(false);
  });
  it('uses custom wording, capped in length', () => {
    expect(callStartNotice({ ...IN, disclosureText: '  Yeh call AI assistant se hai.  ' })).toBe('Yeh call AI assistant se hai.');
    expect(callStartNotice({ ...IN, disclosureText: 'x'.repeat(1000) })!.length).toBe(400);
  });
  it('adds the privacy link to texts only when the notice is on and a URL is set', () => {
    expect(privacyLinkSuffix({ ...US, privacyNoticeUrl: 'https://a.example/p' })).toBe('');
    expect(privacyLinkSuffix(IN)).toBe('');
    expect(privacyLinkSuffix({ ...IN, privacyNoticeUrl: 'https://a.example/p' })).toBe(' Privacy notice: https://a.example/p');
    expect(whatsappNotice(US)).toBeNull();
    expect(whatsappNotice({ ...IN, privacyNoticeUrl: 'https://a.example/p' })).toMatch(/AI assistant.*Privacy notice: https:\/\/a\.example\/p$/);
  });
  it('validates privacy URLs', () => {
    expect(validPrivacyUrl('https://clinic.example/privacy')).toBe('https://clinic.example/privacy');
    expect(validPrivacyUrl('javascript:alert(1)')).toBeNull();
    expect(validPrivacyUrl('not a url')).toBeNull();
  });
  it('versions notice wording stably', async () => {
    expect(await noticeVersion('a')).toBe(await noticeVersion('a'));
    expect(await noticeVersion('a')).not.toBe(await noticeVersion('b'));
    expect(await noticeVersion('a')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('privacy settings validation', () => {
  it('accepts partial updates and null to clear', () => {
    expect(parsePrivacySettings({ aiDisclosure: null, retentionDays: '90' })).toEqual({ settings: { aiDisclosure: null, retentionDays: 90 } });
    expect(parsePrivacySettings({ disclosureText: '  ', privacyNoticeUrl: '' })).toEqual({ settings: { disclosureText: null, privacyNoticeUrl: null } });
    expect(parsePrivacySettings({})).toEqual({ settings: {} });
  });
  it('rejects bad values', () => {
    expect(parsePrivacySettings({ aiDisclosure: 'yes' })).toHaveProperty('error');
    expect(parsePrivacySettings({ retentionDays: 0 })).toHaveProperty('error');
    expect(parsePrivacySettings({ retentionDays: 1.5 })).toHaveProperty('error');
    expect(parsePrivacySettings({ privacyNoticeUrl: 'ftp://x' })).toHaveProperty('error');
    expect(parsePrivacySettings({ disclosureText: 'x'.repeat(401) })).toHaveProperty('error');
  });
  it('retention days', () => {
    expect(validRetentionDays(null)).toBeNull();
    expect(validRetentionDays(30)).toBe(30);
    expect(validRetentionDays(99999)).toBeUndefined();
  });
});

describe('subject identification', () => {
  it('normalises phone numbers to digits with country code', () => {
    expect(phoneDigits('+91 98765 43210')).toBe('919876543210');
    expect(phoneDigits('+1 (312) 555-0100')).toBe('13125550100');
    expect(phoneDigits('12345')).toBeNull();
    expect(phoneDigits('call me')).toBeNull();
  });
  it('hashes the same way calls do (digits of the number)', async () => {
    const env = { CUSTOMER_HASH_SALT: 'salt' } as Env;
    const s = await resolveSubject(env, { phone: '+91 98765-43210' });
    expect(s).toEqual({ hash: await hashId('919876543210', 'salt'), e164: '+919876543210' });
    expect(await resolveSubject(env, {})).toHaveProperty('error');
    expect(await resolveSubject(env, { customerIdHashed: 'a'.repeat(64) })).toEqual({ hash: 'a'.repeat(64), e164: null });
  });
  it('lists the live-history KV keys for a caller', () => {
    expect(kvKeysFor('b', 'h', ['CA1'])).toEqual({
      cart: ['call:CA1', 'callmsgs:CA1', 'clf:completed:CA1', 'wa:h:b', 'cart:h:b'],
      cache: ['transfer:CA1', 'rl:wa:h'],
    });
  });
  it('treats only future active bookings as upcoming', () => {
    const now = new Date('2026-11-10T06:00:00Z'); // 11:30 IST
    expect(isUpcomingActive({ status: 'PENDING', scheduled_at: '2026-11-10T12:00:00' }, 'Asia/Kolkata', now)).toBe(true);
    expect(isUpcomingActive({ status: 'PENDING', scheduled_at: '2026-11-10T11:00:00' }, 'Asia/Kolkata', now)).toBe(false);
    expect(isUpcomingActive({ status: 'CANCELLED', scheduled_at: '2026-12-01T09:00:00' }, 'Asia/Kolkata', now)).toBe(false);
  });
});

describe('export, erasure and retention against the real schema', () => {
  let db: ReturnType<typeof createTestD1>['db'];
  let env: Env;
  let cart: ReturnType<typeof createTestKV>;
  let cache: ReturnType<typeof createTestKV>;
  let productId: string;
  let me: string;
  let other: string;
  const B = 'sharma_clinic';
  const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const now = new Date('2026-11-10T06:00:00Z');

  beforeEach(async () => {
    const t = createTestD1();
    db = t.db;
    cart = createTestKV();
    cache = createTestKV();
    env = { DB: t.d1, CART: cart, CACHE: cache, CUSTOMER_HASH_SALT: 'salt', NODE_ENV: 'test' } as unknown as Env;
    productId = (db.prepare('SELECT id FROM products LIMIT 1').get() as { id: string }).id;
    me = await hashId('919876543210', 'salt');
    other = await hashId('919999999999', 'salt');
    const ins = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p);
    ins(`INSERT INTO sectors (key, name, model, categories, hours, timezone, currency, created_at, updated_at) VALUES (?, 'Sharma Clinic', 'service', '[]', '{}', 'Asia/Kolkata', 'INR', 0, 0)`, B);
    for (const [id, who, sid, at] of [['t1', me, 'CA1', '2026-11-01'], ['t2', me, 'CA2', '2026-06-01'], ['t3', other, 'CA3', '2026-06-01']] as const) {
      ins(`INSERT INTO transcripts (id, call_sid, customer_id_hashed, business_type, turns, created_at, updated_at) VALUES (?, ?, ?, ?, '[{"role":"user","content":"hi"}]', ?, ?)`, id, sid, who, B, sec(at), sec(at));
    }
    ins(`INSERT INTO transcripts (id, call_sid, customer_id_hashed, business_type, turns, created_at, updated_at) VALUES ('t4', 'CA4', ?, 'advanced_vtech', '[]', 0, 0)`, me);
    ins(`INSERT INTO call_messages (id, business_type, call_sid, caller_name, callback_phone, message, created_at, customer_id_hashed) VALUES ('m1', ?, 'CA1', 'Asha', '+919876543210', 'call me', ?, ?)`, B, sec('2026-11-01'), me);
    ins(`INSERT INTO call_messages (id, business_type, call_sid, caller_name, callback_phone, message, created_at) VALUES ('m2', ?, 'CA2', 'Asha', '+910000000000', 'old row, no hash', ?)`, B, sec('2026-06-01'));
    ins(`INSERT INTO call_messages (id, business_type, call_sid, caller_name, callback_phone, message, created_at) VALUES ('m3', ?, 'CA3', 'Ravi', '+919999999999', 'other caller', ?)`, B, sec('2026-11-01'));
    const order = (id: string, who: string, status: string, at: string, phone: string) => ins(
      `INSERT INTO orders (id, customer_id_hashed, business_type, product_id, vendor_name, product_name, status, price_cents, payment_method, scheduled_at, customer_name, callback_phone, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'v', 'Consultation', ?, 50000, 'pay_at_visit', ?, 'Asha', ?, 'knee pain', 0, 0)`, id, who, B, productId, status, at, phone);
    order('o1', me, 'COMPLETE', '2026-10-01T10:00:00', '+919876543210');
    order('o2', me, 'PENDING', '2026-11-20T10:00:00', '+919876543210');
    order('o3', other, 'PENDING', '2026-11-21T10:00:00', '+919999999999');
    ins(`INSERT INTO customers (id_hashed, tier, store_credit_cents, created_at, updated_at) VALUES (?, 'BASIC', 0, 0, 0)`, me);
    await recordConsent(env, { businessType: B, channel: 'voice', callSid: 'CA1', customerIdHashed: me, noticeText: DEFAULT_DISCLOSURE_TEXT, playedAt: new Date('2026-11-01T00:00:00Z'), heardFully: true });
    await recordConsent(env, { businessType: B, channel: 'voice', callSid: 'CA3', customerIdHashed: other, noticeText: DEFAULT_DISCLOSURE_TEXT, playedAt: new Date('2025-06-01T00:00:00Z'), heardFully: false });
    cart.store.set('call:CA1', '[{"role":"user","content":"hi"}]');
    cart.store.set(`wa:${me}:${B}`, '[]');
    cart.store.set('call:CA3', '[]');
  });

  it('exports everything stored for the caller and nothing of anyone else', async () => {
    const data = await exportSubjectData(env, B, { hash: me, e164: '+919876543210' });
    expect(data.transcripts.map(t => t.id)).toEqual(['t2', 't1']);
    expect(data.messages.map(m => m.id).sort()).toEqual(['m1', 'm2']);
    expect(data.bookings.map(o => o.id)).toEqual(['o1', 'o2']);
    expect(data.noticeRecords).toHaveLength(1);
    expect(data.customer).not.toBeNull();
    expect(Object.keys(data.liveHistory).sort()).toEqual(['call:CA1', `wa:${me}:${B}`]);
    expect(db.prepare(`SELECT kind FROM data_requests`).all()).toEqual([{ kind: 'export' }]);
  });

  it('erases personal data, keeps aggregate bookings, and leaves other callers alone', async () => {
    const summary = await eraseSubjectData(env, B, { hash: me, e164: '+919876543210' }, 'Asia/Kolkata', now);
    expect(summary).toMatchObject({
      transcriptsDeleted: 2, messagesDeleted: 2, bookingsAnonymised: 2, upcomingBookingsCancelled: 1, noticeRecordsUnlinked: 1,
      // still has a transcript at another business
      customerRowDeleted: false,
    });
    expect(db.prepare(`SELECT id FROM transcripts WHERE business_type = ? ORDER BY id`).all(B)).toEqual([{ id: 't3' }]);
    expect(db.prepare(`SELECT id FROM call_messages ORDER BY id`).all()).toEqual([{ id: 'm3' }]);
    const orders = db.prepare(`SELECT id, customer_id_hashed, status, customer_name, callback_phone, notes, price_cents, scheduled_at FROM orders ORDER BY id`).all();
    expect(orders).toEqual([
      { id: 'o1', customer_id_hashed: ERASED_ID, status: 'COMPLETE', customer_name: null, callback_phone: null, notes: null, price_cents: 50000, scheduled_at: '2026-10-01T10:00:00' },
      { id: 'o2', customer_id_hashed: ERASED_ID, status: 'CANCELLED', customer_name: null, callback_phone: null, notes: null, price_cents: 50000, scheduled_at: '2026-11-20T10:00:00' },
      { id: 'o3', customer_id_hashed: other, status: 'PENDING', customer_name: 'Asha', callback_phone: '+919999999999', notes: 'knee pain', price_cents: 50000, scheduled_at: '2026-11-21T10:00:00' },
    ]);
    expect(db.prepare(`SELECT call_sid, customer_id_hashed FROM consent_records ORDER BY call_sid`).all())
      .toEqual([{ call_sid: 'CA1', customer_id_hashed: null }, { call_sid: 'CA3', customer_id_hashed: other }]);
    expect(cart.store.has('call:CA1')).toBe(false);
    expect(cart.store.has(`wa:${me}:${B}`)).toBe(false);
    expect(cart.store.has('call:CA3')).toBe(true);
    expect(db.prepare(`SELECT kind FROM data_requests`).all()).toEqual([{ kind: 'erase' }]);
  });

  it('drops the customers row once no business holds data for the caller', async () => {
    db.prepare(`DELETE FROM transcripts WHERE id = 't4'`).run();
    const summary = await eraseSubjectData(env, B, { hash: me, e164: '+919876543210' }, 'Asia/Kolkata', now);
    expect(summary.customerRowDeleted).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM customers WHERE id_hashed = ?').get(me)).toEqual({ n: 0 });
  });

  it('retention deletes only old transcripts/messages of businesses that set a period', async () => {
    expect(await applyRetention(env, now)).toEqual([]);  // nothing configured → nothing deleted
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcripts').get()).toEqual({ n: 4 });

    db.prepare('UPDATE sectors SET retention_days = 90 WHERE key = ?').run(B);
    const [r] = await applyRetention(env, now);
    expect(r).toEqual({ businessType: B, retentionDays: 90, transcripts: 2, messages: 1, noticeRecords: 1 });
    expect(db.prepare('SELECT id FROM transcripts ORDER BY id').all()).toEqual([{ id: 't1' }, { id: 't4' }]);
    expect(db.prepare('SELECT id FROM call_messages ORDER BY id').all()).toEqual([{ id: 'm1' }, { id: 'm3' }]);
    // The notice log is kept at least a year: only the 2025 record went.
    expect(db.prepare('SELECT call_sid FROM consent_records').all()).toEqual([{ call_sid: 'CA1' }]);
    // Bookings are never touched by retention.
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 3 });
  });

  it('retention cutoffs keep the notice log at least 365 days', () => {
    const c = retentionCutoffs(30, now);
    const nowSec = now.getTime() / 1000;
    expect(nowSec - c.data).toBe(30 * 86400);
    expect(nowSec - c.consent).toBe(365 * 86400);
    expect(nowSec - retentionCutoffs(400, now).consent).toBe(400 * 86400);
  });
});
