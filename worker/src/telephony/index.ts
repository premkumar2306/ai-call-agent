import { TwilioAdapter } from './twilio';
import { ExotelAdapter } from './exotel';
import { PlivoAdapter } from './plivo';
import type { TelephonyAdapter, TelephonyProvider } from './types';

export * from './types';
export { TwilioAdapter, ExotelAdapter, PlivoAdapter };

export function createTelephonyAdapter(provider: TelephonyProvider): TelephonyAdapter {
  switch (provider) {
    case 'exotel': return new ExotelAdapter();
    case 'plivo': return new PlivoAdapter();
    default: return new TwilioAdapter();
  }
}

// Header a stream route sets on the request it forwards into CallRelay, so
// the Durable Object knows which protocol the socket speaks. Each route
// overwrites it, so a client can't pick a different adapter.
export const PROVIDER_HEADER = 'X-Avery-Telephony';
// Set (to '1') only by a route that has already authenticated the socket
// itself (Exotel static-URL Basic auth). Routes delete any client-sent copy.
export const PREAUTH_HEADER = 'X-Avery-Stream-Preauth';
