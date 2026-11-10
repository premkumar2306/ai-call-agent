import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

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
  // DPDP (0014): null = automatic (on in India), true/false = forced.
  aiDisclosure:     integer('ai_disclosure', { mode: 'boolean' }),
  disclosureText:   text('disclosure_text'),
  privacyNoticeUrl: text('privacy_notice_url'),
  retentionDays:    integer('retention_days'),            // null = keep
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
