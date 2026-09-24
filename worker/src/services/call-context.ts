import type Anthropic from '@anthropic-ai/sdk';
import type { SectorMeta, Product, Order } from '../types';
import type { Turn } from './turn.service';

// Per-call in-memory cache. CallRelay (the Durable Object that lives for the
// whole phone call) holds one of these on `this` and passes it into every
// runTurn()/executeTool() call, so data that can't change within a call
// (sector metadata, tool schema) or that we know how to invalidate on the
// tool calls that change it (orders, booked slots) doesn't cost a fresh
// KV/D1 round trip every turn. See issue #7.
//
// Callers without a persistent DO (e.g. the stateless /twilio/turn TwiML
// route) simply don't pass one — runTurn() falls back to its old
// KV-backed behaviour when `cache` is omitted.
export interface CallCache {
  sectorMeta: SectorMeta | null;
  // Full, unfiltered product list for the business — used for recommendation
  // scoring every turn and reused (when no category filter is requested) by
  // search_services / get_recommendations.
  productsAll: Product[] | null;
  toolDefs: Anthropic.Tool[] | null;
  history: Turn[];
  orders: Order[] | null;
  ordersLoaded: boolean;
  // "YYYY-MM-DDTHH:MM" keys of confirmed (non-cancelled) bookings within the
  // next 14 days. Prefetched at call start; kept in sync by book_appointment
  // / cancel_booking so check_availability never needs a D1 round trip.
  bookedDatetimes: Set<string> | null;
}

export function createCallCache(): CallCache {
  return {
    sectorMeta: null,
    productsAll: null,
    toolDefs: null,
    history: [],
    orders: null,
    ordersLoaded: false,
    bookedDatetimes: null,
  };
}
