import type { VoiceSettings } from './services/voice-language';

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
  // BCP 47 locale for prices and dates ("en-US", "en-IN"). Default en-US.
  locale?: string;
  // ISO 3166-1 country for reading local phone numbers ("US", "IN"). Default US.
  countryCode?: string;
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
  // Key into VERTICALS (services/verticals.ts): what a booking records and
  // the extra prompt rules. Unset = 'general' (the original auto-shop flow).
  vertical?: string;
  // Bookable people with their own hours (a clinic's doctors). When present,
  // availability and conflicts are per resource instead of `capacity`.
  resources?: Resource[];
  // DPDP / AI disclosure (services/disclosure.ts). aiDisclosure undefined =
  // automatic: on for businesses in India, off elsewhere.
  aiDisclosure?: boolean;
  disclosureText?: string;
  privacyNoticeUrl?: string;
  // Days to keep transcripts and staff messages (services/retention.ts).
  retentionDays?: number;
  // Phone-line language and STT/TTS providers (migration 0012). Absent on
  // sector lists cached before it shipped — resolveVoiceSettings() defaults.
  voice?: VoiceSettings;
  // What kind of business (clinic, salon, auto_shop…), set by the onboarding wizard.
  kind?: string;
}

/** Someone a booking is made with — a clinic's doctor — with their own hours. */
export interface Resource {
  id: string;
  name: string;            // "Dr. Ananya Rao"
  role?: string;           // "General physician"
  hours: WeeklyHours;      // e.g. { mon: "10am–1pm, 5pm–9pm" }
  slotMinutes: number;     // appointment grid and default length
  feeCents?: number | null; // consultation fee, minor units of the business currency
  about?: string;          // languages spoken, etc.
  categories?: string[];   // product categories they do (a dentist: DENTAL); unset = all
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
  resourceId?: string | null;     // the doctor (Resource) the booking is with
  resourceName?: string | null;
  endsAt?: string | null;         // business-local end, for per-resource overlap checks
  details?: Record<string, string> | null; // vertical booking fields (patient age, reason…)
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
  // Sarvam AI (Hindi / Hinglish voice). Secret; only needed by businesses
  // whose voice settings pick Sarvam — those fail closed without it.
  SARVAM_API_KEY?: string;
  SARVAM_STT_MODEL?: string;         // default saaras:v3
  SARVAM_TTS_MODEL?: string;         // default bulbul:v3
  SARVAM_TTS_SPEAKER?: string;       // default speaker when a business sets no voice_id
  SARVAM_TTS_CODEC?: string;         // 'mulaw' (default) | 'linear16'
  SARVAM_HIGH_VAD_SENSITIVITY?: string; // '1' for Sarvam's high-sensitivity VAD
  RELAY_DO: DurableObjectNamespace;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** Enables confirmation texts (with TWILIO_SMS_FROM, a Twilio number that can send SMS). */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_SMS_FROM?: string;
  TWILIO_WEBHOOK_URL?: string;
  NODE_ENV?: string;
  // End-to-end tests only (worker/e2e): base URL of the local provider stand-ins.
  // Ignored when NODE_ENV is "production". See utils/provider-mock.ts.
  PROVIDER_MOCK_URL?: string;
  // Set to '1'/'true' to enable verbose Deepgram STT logging (Results /
  // UtteranceEnd messages + which signal triggered finalize()). Off by
  // default to avoid flooding wrangler tail.
  DG_DEBUG?: string;
  // Noise-robustness knobs for the phone STT (see SttOptions in stt-deepgram.ts).
  DG_ENDPOINTING_MS?: string;
  DG_MIN_CONFIDENCE?: string;
  DG_BARGE_IN_MIN_WORDS?: string;
  DG_INCOMPLETE_HOLD_MS?: string;
  DG_STATEMENT_HOLD_MS?: string;
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
  // Exotel (Indian numbers, routes/exotel.ts). EXOTEL_WEBHOOK_SECRET is a
  // secret: Exotel doesn't sign webhooks, so every /exotel/* URL configured in
  // the call flow carries it (Basic auth or ?key=). Required in production.
  EXOTEL_WEBHOOK_SECRET?: string;
  /** Business for ExoPhones with no phone_numbers row. Unset = such calls are refused. */
  EXOTEL_DEFAULT_BUSINESS_TYPE?: string;
  // Plivo (routes/plivo.ts). PLIVO_AUTH_TOKEN verifies X-Plivo-Signature-V3;
  // PLIVO_WEBHOOK_URL is the public base URL Plivo calls. Both required in production.
  PLIVO_AUTH_TOKEN?: string;
  PLIVO_WEBHOOK_URL?: string;
  /** Business for Plivo numbers with no phone_numbers row. */
  PLIVO_DEFAULT_BUSINESS_TYPE?: string;
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
  // Billing (services/billing/). Secrets: the Razorpay API key pair and the
  // webhook secret from Dashboard → Webhooks. Without RAZORPAY_WEBHOOK_SECRET
  // the webhook rejects everything in production.
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  /** Plain var: the operator's GSTIN, printed on invoices and used for the CGST/SGST vs IGST split. */
  BILLING_SUPPLIER_GSTIN?: string;
  /** Plain var: JSON merged over DEFAULT_COST_RATES (pricing.ts) for the margin estimate. */
  BILLING_COST_RATES?: string;
}
