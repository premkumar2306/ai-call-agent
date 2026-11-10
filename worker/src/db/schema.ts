import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const sectors = sqliteTable('sectors', {
  key:          text('key').primaryKey(),
  name:         text('name').notNull(),
  model:        text('model').notNull(),
  categories:   text('categories', { mode: 'json' }).notNull().$type<string[]>(),
  hours:        text('hours', { mode: 'json' }).notNull().$type<Record<string, string>>(),
  timezone:     text('timezone').notNull().default('America/Chicago'),
  currency:     text('currency').notNull().default('USD'),
  address:      text('address'),
  phone:        text('phone'),
  website:      text('website'),
  about:        text('about'),
  notifyEmail:  text('notify_email'),
  capacity:     integer('capacity').notNull().default(1),
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
  createdAt:     integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (t) => [
  index('idx_call_messages_business_created').on(t.businessType, t.createdAt),
]);

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
