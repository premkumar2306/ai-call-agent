import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

export const sectors = sqliteTable('sectors', {
  key:          text('key').primaryKey(),
  name:         text('name').notNull(),
  model:        text('model').notNull(),
  categories:   text('categories', { mode: 'json' }).notNull().$type<string[]>(),
  hours:        text('hours', { mode: 'json' }).notNull().$type<Record<string, string>>(),
  timezone:     text('timezone').notNull().default('America/Chicago'),
  currency:     text('currency').notNull().default('USD'),
  locale:       text('locale').notNull().default('en-US'),
  countryCode:  text('country_code').notNull().default('US'),
  address:      text('address'),
  phone:        text('phone'),
  website:      text('website'),
  about:        text('about'),
  notifyEmail:  text('notify_email'),
  capacity:     integer('capacity').notNull().default(1),
  vertical:     text('vertical'),                       // services/verticals.ts key; NULL = general
  // DPDP (0014): null = automatic (on in India), true/false = forced.
  aiDisclosure:     integer('ai_disclosure', { mode: 'boolean' }),
  disclosureText:   text('disclosure_text'),
  privacyNoticeUrl: text('privacy_notice_url'),
  retentionDays:    integer('retention_days'),            // null = keep
  // Phone-line language + providers (0012). Defaults = English, Deepgram, Cartesia.
  voiceLanguage: text('voice_language').notNull().default('en'),   // en | hi | hi-en
  sttProvider:   text('stt_provider').notNull().default('deepgram'), // deepgram | sarvam
  ttsProvider:   text('tts_provider').notNull().default('cartesia'), // cartesia | sarvam
  voiceId:       text('voice_id'),                                   // Cartesia voice id / Sarvam speaker; null = default
  kind:         text('kind'),                 // clinic | salon | auto_shop… (onboarding wizard)
  isActive:     integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt:    integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt:    integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const vendors = sqliteTable('vendors', {
  id:           text('id').primaryKey(),
  name:         text('name').notNull(),
  businessType: text('business_type').notNull(),
  contactEmail: text('contact_email').notNull(),
  apiBaseUrl:   text('api_base_url'),
  isActive:     integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt:    integer('created_at', { mode: 'timestamp' }).notNull()
                  .$defaultFn(() => new Date()),
});

export const products = sqliteTable('products', {
  id:                 text('id').primaryKey(),
  businessType:       text('business_type').notNull(),
  vendorId:           text('vendor_id').notNull().references(() => vendors.id),
  vendorName:         text('vendor_name').notNull(),
  name:               text('name').notNull(),
  category:           text('category').notNull(),
  type:               text('type').notNull(),           // SERVICE_APPOINTMENT | PHYSICAL_PART | PHYSICAL_ACCESSORY | DIGITAL
  fulfillmentType:    text('fulfillment_type').notNull(), // SERVICE_BOOKING | VENDOR_SHIP | IN_STORE_PICKUP
  description:        text('description').notNull(),
  priceCents:         integer('price_cents').notNull(),
  originalPriceCents: integer('original_price_cents').notNull(),
  isActive:           integer('is_active', { mode: 'boolean' }).notNull().default(true),
  imageUrl:           text('image_url'),
  upsellProductId:    text('upsell_product_id'),        // recommended upgrade / add-on
  durationMinutes:    integer('duration_minutes'),      // appointment length (null for physical products)
  createdAt:          integer('created_at', { mode: 'timestamp' }).notNull()
                        .$defaultFn(() => new Date()),
}, (t) => [
  index('idx_products_business_type_active').on(t.businessType, t.isActive),
  index('idx_products_category').on(t.category),
]);

export const orders = sqliteTable('orders', {
  id:               text('id').primaryKey(),
  customerIdHashed: text('customer_id_hashed').notNull(),
  businessType:     text('business_type').notNull(),
  productId:        text('product_id').notNull().references(() => products.id),
  vendorName:       text('vendor_name').notNull(),
  productName:      text('product_name').notNull(),
  status:           text('status').notNull().default('PENDING'),
  priceCents:       integer('price_cents').notNull(),
  paymentMethod:    text('payment_method').notNull(),
  trackingNumber:   text('tracking_number'),
  scheduledAt:      text('scheduled_at'),               // ISO datetime for service bookings
  calendarEventId:  text('calendar_event_id'),          // event in the business's connected calendar
  calendarSync:     text('calendar_sync'),              // null (not connected) | synced | failed
  customerName:     text('customer_name'),
  vehicle:          text('vehicle'),
  callbackPhone:    text('callback_phone'),             // E.164, from caller ID or given on the call
  notes:            text('notes'),
  resourceId:       text('resource_id'),                // resources.id (a clinic's doctor)
  resourceName:     text('resource_name'),
  endsAt:           text('ends_at'),                    // business-local end, set for resource bookings
  details:          text('details', { mode: 'json' }).$type<Record<string, string>>(), // vertical booking fields
  shippingLine1:    text('shipping_line1'),
  shippingCity:     text('shipping_city'),
  shippingState:    text('shipping_state'),
  shippingZip:      text('shipping_zip'),
  createdAt:        integer('created_at', { mode: 'timestamp' }).notNull()
                      .$defaultFn(() => new Date()),
  updatedAt:        integer('updated_at', { mode: 'timestamp' }).notNull()
                      .$defaultFn(() => new Date()),
}, (t) => [
  index('idx_orders_customer_business_type').on(t.customerIdHashed, t.businessType),
  // Supports getBookedDatetimes() in tool-router.service.ts — a
  // businessType + [now, now+14d] scheduledAt range scan for
  // check_availability. Without this the query was a full-table scan (the
  // only prior index leads with customerIdHashed, wrong column for this
  // lookup). See issue #7.
  index('idx_orders_business_type_scheduled').on(t.businessType, t.scheduledAt),
  index('idx_orders_resource_scheduled').on(t.resourceId, t.scheduledAt),
]);

// People a booking is made with, each with their own weekly hours — a
// clinic's doctors (OPD timings, slot length, consultation fee).
export const resources = sqliteTable('resources', {
  id:           text('id').primaryKey(),
  businessType: text('business_type').notNull(),
  name:         text('name').notNull(),
  role:         text('role'),
  hours:        text('hours', { mode: 'json' }).notNull().$type<Record<string, string>>(),
  slotMinutes:  integer('slot_minutes').notNull().default(15),
  feeCents:     integer('fee_cents'),
  about:        text('about'),
  categories:   text('categories', { mode: 'json' }).$type<string[]>(), // product categories they do; null = all
  sortOrder:    integer('sort_order').notNull().default(0),
  isActive:     integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt:    integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index('idx_resources_business_active').on(t.businessType, t.isActive),
]);

// One external calendar per business. Only Google today; `provider` leaves
// room for Microsoft without a schema change.
export const calendarConnections = sqliteTable('calendar_connections', {
  businessType:    text('business_type').primaryKey(),
  provider:        text('provider').notNull(),              // google
  accountEmail:    text('account_email'),
  calendarId:      text('calendar_id').notNull().default('primary'),
  calendarName:    text('calendar_name'),
  refreshTokenEnc: text('refresh_token_enc').notNull(),     // AES-GCM, see calendar-crypto.ts
  checkBusy:       integer('check_busy', { mode: 'boolean' }).notNull().default(true),
  writeEvents:     integer('write_events', { mode: 'boolean' }).notNull().default(true),
  status:          text('status').notNull().default('active'), // active | reauth_required
  lastError:       text('last_error'),
  createdAt:       integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt:       integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const customers = sqliteTable('customers', {
  idHashed:         text('id_hashed').primaryKey(),
  tier:             text('tier').notNull().default('BASIC'),
  storeCreditCents: integer('store_credit_cents').notNull().default(0),
  createdAt:        integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt:        integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const transcripts = sqliteTable('transcripts', {
  id:               text('id').primaryKey(),
  callSid:          text('call_sid'),
  customerIdHashed: text('customer_id_hashed').notNull(),
  businessType:     text('business_type').notNull(),
  emailSentTo:      text('email_sent_to'),
  turns:            text('turns', { mode: 'json' }).notNull().$type<Array<{ role: string; content: string }>>(),
  metrics:          text('metrics', { mode: 'json' }).$type<unknown[]>(),
  createdAt:        integer('created_at', { mode: 'timestamp' }).notNull()
                      .$defaultFn(() => new Date()),
  updatedAt:        integer('updated_at', { mode: 'timestamp' }).notNull()
                      .$defaultFn(() => new Date()),
}, (t) => [
  index('idx_transcripts_customer_business_type').on(t.customerIdHashed, t.businessType),
  index('idx_transcripts_call_sid').on(t.callSid),
  index('idx_transcripts_business_updated').on(t.businessType, t.updatedAt),
]);

// Messages a caller left for staff ("have someone call me about a quote").
export const callMessages = sqliteTable('call_messages', {
  id:            text('id').primaryKey(),
  businessType:  text('business_type').notNull(),
  callSid:       text('call_sid'),
  callerName:    text('caller_name'),
  callbackPhone: text('callback_phone'),
  message:       text('message').notNull(),
  status:        text('status').notNull().default('NEW'),
  customerIdHashed: text('customer_id_hashed'),
  createdAt:     integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index('idx_call_messages_business_created').on(t.businessType, t.createdAt),
  index('idx_call_messages_customer').on(t.customerIdHashed),
]);

// When the call-start notice (AI assistant, transcription) was given — the
// audit trail for DPDP notice. See services/disclosure.ts.
export const consentRecords = sqliteTable('consent_records', {
  id:               text('id').primaryKey(),
  businessType:     text('business_type').notNull(),
  channel:          text('channel').notNull(),            // voice | whatsapp
  callSid:          text('call_sid'),
  customerIdHashed: text('customer_id_hashed'),           // null after erasure
  noticeVersion:    text('notice_version').notNull(),
  noticeText:       text('notice_text').notNull(),
  playedAt:         integer('played_at', { mode: 'timestamp' }).notNull(),
  heardFully:       integer('heard_fully', { mode: 'boolean' }),
  createdAt:        integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index('idx_consent_records_business_played').on(t.businessType, t.playedAt),
  index('idx_consent_records_customer').on(t.customerIdHashed),
]);

// Data-principal requests (export / erasure) handled via /admin/privacy.
export const dataRequests = sqliteTable('data_requests', {
  id:               text('id').primaryKey(),
  businessType:     text('business_type').notNull(),
  kind:             text('kind').notNull(),               // export | erase
  customerIdHashed: text('customer_id_hashed').notNull(),
  summary:          text('summary', { mode: 'json' }),
  createdAt:        integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index('idx_data_requests_business_created').on(t.businessType, t.createdAt),
]);

// Called number → business, per carrier (drizzle/0013_phone_numbers.sql).
export const phoneNumbers = sqliteTable('phone_numbers', {
  number:       text('number').notNull(),          // E.164
  provider:     text('provider').notNull(),        // twilio | exotel | plivo
  businessType: text('business_type').notNull(),
  label:        text('label'),
  createdAt:    integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt:    integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  primaryKey({ columns: [t.number, t.provider] }),
  index('idx_phone_numbers_business').on(t.businessType),
]);

// ── Owner accounts (drizzle/0015_owner_accounts.sql) ───────────────────────
// Business owners and their staff sign in with an emailed one-time code.
export const users = sqliteTable('users', {
  id:             text('id').primaryKey(),
  email:          text('email').notNull(),
  name:           text('name'),
  phone:          text('phone'),
  sessionVersion: integer('session_version').notNull().default(1),
  lastLoginAt:    integer('last_login_at', { mode: 'timestamp' }),
  createdAt:      integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex('idx_users_email').on(t.email),
]);

export const businessMembers = sqliteTable('business_members', {
  businessKey: text('business_key').notNull(),
  userId:      text('user_id').notNull(),
  role:        text('role').notNull().default('staff'), // owner | staff
  createdAt:   integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  primaryKey({ columns: [t.businessKey, t.userId] }),
  index('idx_business_members_user').on(t.userId),
]);

export const loginCodes = sqliteTable('login_codes', {
  identifier: text('identifier').primaryKey(),     // 'email:<address>'
  codeHash:   text('code_hash').notNull(),         // HMAC, never the code
  attempts:   integer('attempts').notNull().default(0),
  expiresAt:  integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt:  integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// ── Billing (workstream F, migration 0016) ──────────────────────────────────
// All times are unix seconds; money is in paise excluding GST unless named
// otherwise; provider costs in micro-USD. Billing is off for a business until
// billing_accounts.plan_id is set.

export const billingPlans = sqliteTable('billing_plans', {
  id:                    text('id').primaryKey(),
  name:                  text('name').notNull(),
  currency:              text('currency').notNull().default('INR'),
  monthlyFeePaise:       integer('monthly_fee_paise').notNull(),
  includedMinutes:       integer('included_minutes').notNull(),
  overagePaisePerMinute: integer('overage_paise_per_minute').notNull(),
  trialDays:             integer('trial_days').notNull().default(0),
  gstRateBps:            integer('gst_rate_bps').notNull().default(1800),
  razorpayPlanId:        text('razorpay_plan_id'),
  isActive:              integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt:             integer('created_at').notNull(),
  updatedAt:             integer('updated_at').notNull(),
});

export const billingAccounts = sqliteTable('billing_accounts', {
  businessType:           text('business_type').primaryKey(),   // sectors.key
  planId:                 text('plan_id'),
  trialEndsAt:            integer('trial_ends_at'),
  razorpayCustomerId:     text('razorpay_customer_id'),
  razorpaySubscriptionId: text('razorpay_subscription_id'),
  subscriptionStatus:     text('subscription_status'),
  currentPeriodEnd:       integer('current_period_end'),
  legalName:              text('legal_name'),
  gstin:                  text('gstin'),
  billingEmail:           text('billing_email'),
  addressLine1:           text('address_line1'),
  addressLine2:           text('address_line2'),
  city:                   text('city'),
  state:                  text('state'),
  postalCode:             text('postal_code'),
  country:                text('country').notNull().default('IN'),
  alert80Period:          text('alert_80_period'),
  alert100Period:         text('alert_100_period'),
  createdAt:              integer('created_at').notNull(),
  updatedAt:              integer('updated_at').notNull(),
}, (t) => [
  index('idx_billing_accounts_subscription').on(t.razorpaySubscriptionId),
]);

export const usageRecords = sqliteTable('usage_records', {
  id:                  text('id').primaryKey(),
  businessType:        text('business_type').notNull(),
  channel:             text('channel').notNull(),            // voice | whatsapp
  provider:            text('provider'),
  sourceId:            text('source_id').notNull(),
  period:              text('period').notNull(),             // YYYY-MM, Asia/Kolkata
  startedAt:           integer('started_at').notNull(),
  endedAt:             integer('ended_at'),
  durationSeconds:     integer('duration_seconds').notNull().default(0),
  billableMinutes:     integer('billable_minutes').notNull().default(0),
  billable:            integer('billable', { mode: 'boolean' }).notNull().default(true),
  sttSeconds:          integer('stt_seconds').notNull().default(0),
  ttsChars:            integer('tts_chars').notNull().default(0),
  llmModel:            text('llm_model'),
  llmInputTokens:      integer('llm_input_tokens').notNull().default(0),
  llmOutputTokens:     integer('llm_output_tokens').notNull().default(0),
  llmCacheReadTokens:  integer('llm_cache_read_tokens').notNull().default(0),
  llmCacheWriteTokens: integer('llm_cache_write_tokens').notNull().default(0),
  costUsdMicros:       integer('cost_usd_micros').notNull().default(0),
  createdAt:           integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('idx_usage_records_source').on(t.channel, t.sourceId),
  index('idx_usage_records_business_period').on(t.businessType, t.period),
]);

export const billingInvoices = sqliteTable('billing_invoices', {
  id:              text('id').primaryKey(),
  businessType:    text('business_type').notNull(),
  period:          text('period').notNull(),
  planId:          text('plan_id'),
  minutesUsed:     integer('minutes_used').notNull(),
  includedMinutes: integer('included_minutes').notNull(),
  overageMinutes:  integer('overage_minutes').notNull(),
  overagePaise:    integer('overage_paise').notNull(),
  gstPaise:        integer('gst_paise').notNull(),
  totalPaise:      integer('total_paise').notNull(),
  status:          text('status').notNull(),   // no_overage | trial | billed | unbilled | failed
  razorpayAddonId: text('razorpay_addon_id'),
  error:           text('error'),
  createdAt:       integer('created_at').notNull(),
  updatedAt:       integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('idx_billing_invoices_business_period').on(t.businessType, t.period),
]);

export const razorpayEvents = sqliteTable('razorpay_events', {
  id:         text('id').primaryKey(),
  event:      text('event').notNull(),
  receivedAt: integer('received_at').notNull(),
});
