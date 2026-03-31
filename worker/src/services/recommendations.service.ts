import type { Product, SectorMeta } from '../types';

const PRIORITY_CATEGORIES = new Set([
  'BRAKES', 'TIRES', 'DIAGNOSTICS',
  'PREVENTIVE', 'PRIMARY_CARE', 'LABS',
  'CONSULTATION',
]);

export function scoreProducts(
  products: Product[],
  storeCreditCents: number
): Array<Product & { score: number; reason: string }> {
  return products
    .filter(p => p.isActive)
    .map(p => {
      let score = 0;
      let reason = 'Popular service';

      if (p.priceCents === 0) {
        score += 30;
        reason = 'No cost to you';
      }
      if (storeCreditCents > 0 && p.priceCents > 0 && p.priceCents <= storeCreditCents) {
        score += 25;
        reason = 'Covered by your store credit';
      }
      if (p.originalPriceCents > p.priceCents && p.priceCents > 0) {
        const pct = (p.originalPriceCents - p.priceCents) / p.originalPriceCents;
        if (pct >= 0.15) { score += 20; reason = `${Math.round(pct * 100)}% off right now`; }
        if (pct >= 0.30) score += 10;
      }
      if (PRIORITY_CATEGORIES.has(p.category)) {
        score += 20;
        if (reason === 'Popular service') reason = 'Essential service';
      }
      if (p.type === 'SERVICE_APPOINTMENT') score += 10;
      if (p.durationMinutes && p.durationMinutes <= 30) score += 5;

      return { ...p, score, reason };
    })
    .sort((a, b) => b.score - a.score);
}

export function getSectorGreeting(sector: string, storeCreditCents: number, _tier: string, meta?: SectorMeta): string {
  const bizName = meta?.name ?? sector;
  const credit = storeCreditCents > 0 ? ` You have $${(storeCreditCents / 100).toFixed(2)} in store credit.` : '';

  const taglines: Record<string, string> = {
    auto_shop:   "What can I help you with — a service appointment, pricing, or availability?",
    clinic:      "Would you like to book an appointment, check availability, or hear about our services?",
    real_estate: "Looking to buy, rent, or schedule a tour? I can also check availability for a consultation.",
  };

  const tagline = taglines[sector] ?? "How can I assist you today?";
  return `Hi! I'm Avery, your ${bizName} assistant.${credit} ${tagline}`;
}
