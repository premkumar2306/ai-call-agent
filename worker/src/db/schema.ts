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
]);

export const transcripts = sqliteTable('transcripts', {
  id:               text('id').primaryKey(),
  callSid:          text('call_sid'),
  customerIdHashed: text('customer_id_hashed').notNull(),
  businessType:     text('business_type').notNull(),
  emailSentTo:      text('email_sent_to'),
  turns:            text('turns', { mode: 'json' }).notNull().$type<Array<{ role: string; content: string }>>(),
  createdAt:        integer('created_at', { mode: 'timestamp' }).notNull()
                      .$defaultFn(() => new Date()),
  updatedAt:        integer('updated_at', { mode: 'timestamp' }).notNull()
                      .$defaultFn(() => new Date()),
}, (t) => [
  index('idx_transcripts_customer_business_type').on(t.customerIdHashed, t.businessType),
  index('idx_transcripts_call_sid').on(t.callSid),
]);
