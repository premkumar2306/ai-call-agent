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
  // Free-text facts the agent may quote (warranty, certifications, payment
  // options, parking, languages spoken…). Shown verbatim in the prompt.
  about?: string;
  // Where booking/message notifications go (needs RESEND_API_KEY).
  notifyEmail?: string;
  // Different customers' visits that may start at the same time. Default 1.
  capacity?: number;
}

export interface WeeklyHours {
  mon?: string; tue?: string; wed?: string; thu?: string;
  fri?: string; sat?: string; sun?: string;
}

export interface SessionPayload {
  sub: string;       // hashed customer ID
  businessType: string;
  callerPhone?: string; // voice calls: the caller's number (E.164), for callbacks
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
  calendarEventId?: string | null; // "<provider>|<calendarId>|<eventId>" in the business's calendar
  calendarSync?: string | null;    // null (no calendar) | synced | failed
  customerName?: string | null;
  vehicle?: string | null;
  callbackPhone?: string | null;
  notes?: string | null;
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
  MOGI_SECRET: string;
  ADMIN_SECRET: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL?: string;          // overrides DEFAULT_AGENT_MODEL (config.ts)
  VOICE_MODEL?: string;              // overrides DEFAULT_VOICE_MODEL (config.ts)
  // Comma-separated extra CORS origins for the admin UI, e.g. a custom domain.
  ALLOWED_ORIGINS?: string;
  DEEPGRAM_API_KEY?: string;
  CARTESIA_API_KEY?: string;
  CARTESIA_VOICE_ID?: string;
  CARTESIA_MODEL_ID?: string;
  RELAY_DO: DurableObjectNamespace;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** Enables confirmation texts (with TWILIO_SMS_FROM, a Twilio number that can send SMS). */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_SMS_FROM?: string;
  TWILIO_WEBHOOK_URL?: string;
  NODE_ENV?: string;
  // Set to '1'/'true' to enable verbose Deepgram STT logging (Results /
  // UtteranceEnd messages + which signal triggered finalize()). Off by
  // default to avoid flooding wrangler tail.
  DG_DEBUG?: string;
  // Noise-robustness knobs for the phone STT (see SttOptions in stt-deepgram.ts).
  DG_ENDPOINTING_MS?: string;
  DG_MIN_CONFIDENCE?: string;
  DG_BARGE_IN_MIN_WORDS?: string;
  DG_INCOMPLETE_HOLD_MS?: string;
  // Deepgram model / language. Defaults 'nova-3' and 'en' (stt-deepgram.ts);
  // exposed as env so they can be A/B'd against live calls without a code change.
  DG_MODEL?: string;
  DG_LANGUAGE?: string;
  // Set to '1'/'true' to barge in on Deepgram's VAD SpeechStarted event
  // instead of waiting for recognised words. Off by default: line noise and
  // echo cut replies off.
  VOICE_BARGE_IN_ON_VAD?: string;
  /** ms of caller silence (after the assistant finishes) before "Are you still there?"; again → goodbye + hang up. Default 8000. */
  VOICE_SILENCE_REPROMPT_MS?: string;
  // Set to '0'/'false' to disable speaking a self-sufficient tool result
  // directly and always round-trip it through Claude for paraphrasing.
  VOICE_DIRECT_TOOL_REPLY?: string;
  TOKEN_TTL_SECONDS?: string;
  // Twilio inbound call defaults — used when no ?token= in webhook URL
  TWILIO_DEFAULT_BUSINESS_TYPE?: string; // e.g. "auto_shop"
  /** @deprecated Use TWILIO_DEFAULT_BUSINESS_TYPE */
  TWILIO_DEFAULT_SECTOR?: string;
  TWILIO_DEFAULT_CUSTOMER_HASH?: string; // hashed ID for the anonymous caller
  // WhatsApp Cloud API (all secrets — set via `wrangler secret put`)
  WA_APP_SECRET?: string;            // Meta app secret for X-Hub-Signature-256 verification
  WA_VERIFY_TOKEN?: string;          // Arbitrary token used in Meta webhook registration
  WA_PHONE_NUMBER_ID?: string;       // Default Meta phone number ID
  WA_ACCESS_TOKEN?: string;          // Permanent system-user access token
  WA_DEFAULT_BUSINESS_TYPE?: string; // Sector for this WhatsApp number (default: 'advanced_vtech')
  WA_PHONE_NUMBER_MAP?: string;      // Optional JSON: {"<id>":"dental","<id2>":"auto_shop"}
  // External calendars (services/calendar/). CALENDAR_TOKEN_KEY encrypts
  // stored refresh tokens and is required for any provider; each provider
  // then needs its own OAuth client. All secrets.
  CALENDAR_TOKEN_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
