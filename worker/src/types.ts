// BusinessType is a string so new verticals can be added without code changes
export type BusinessType = string;

/** @deprecated Use BusinessType instead */
export type Sector = BusinessType;

export interface SectorMeta {
  name: string;
  model: 'service' | 'retail' | 'mixed';
  categories: string[];
  hours: WeeklyHours;
  timezone: string;
  currency: string;
  // Optional real-business fields populated from web research
  address?: string;
  phone?: string;
  website?: string;
}

export interface WeeklyHours {
  mon?: string; tue?: string; wed?: string; thu?: string;
  fri?: string; sat?: string; sun?: string;
}

// SECTORS is no longer hardcoded — loaded dynamically from D1 via sector.service.ts
// This empty object is kept only so existing imports don't break during migration.
// All runtime code uses getSectors(env) / getSector(env, key) instead.
export const SECTORS: Record<string, SectorMeta> = {};

export interface SessionPayload {
  sub: string;       // hashed customer ID
  businessType: string;
  iat: number;
  exp: number;
  account: {
    store_credit_cents: number;
    tier: 'BASIC' | 'SILVER' | 'GOLD' | 'PLATINUM';
  };
}

export interface Product {
  id: string;
  businessType: string;
  vendorId: string;
  vendorName: string;
  name: string;
  category: string;
  type: string;            // SERVICE_APPOINTMENT | PHYSICAL_PART | PHYSICAL_ACCESSORY | DIGITAL
  fulfillmentType: string; // SERVICE_BOOKING | VENDOR_SHIP | IN_STORE_PICKUP
  description: string;
  priceCents: number;
  originalPriceCents: number;
  isActive: boolean;
  imageUrl?: string | null;
  upsellProductId?: string | null; // recommended upgrade/add-on
  durationMinutes?: number | null; // for appointments
}

export interface Order {
  id: string;
  customerIdHashed: string;
  businessType: string;
  productId: string;
  productName: string;
  vendorName: string;
  status: string;
  priceCents: number;
  paymentMethod: string;
  trackingNumber?: string | null;
  scheduledAt?: string | null;   // ISO datetime for bookings
  createdAt: string;
  updatedAt: string;
}

// Cloudflare Workers bindings
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  CART: KVNamespace;
  TOKEN_SECRET: string;
  CUSTOMER_HASH_SALT: string;
  AVERY_SECRET: string;
  ANTHROPIC_API_KEY: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WEBHOOK_URL?: string;
  NODE_ENV?: string;
  TOKEN_TTL_SECONDS?: string;
  // Twilio inbound call defaults — used when no ?token= in webhook URL
  TWILIO_DEFAULT_BUSINESS_TYPE?: string; // e.g. "auto_shop"
  /** @deprecated Use TWILIO_DEFAULT_BUSINESS_TYPE */
  TWILIO_DEFAULT_SECTOR?: string;
  TWILIO_DEFAULT_CUSTOMER_HASH?: string; // hashed ID for the anonymous caller
}
