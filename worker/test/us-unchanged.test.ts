import { describe, expect, it } from 'vitest';
import { buildAgentRules, agentTools } from '../src/services/turn.service';
import { buildBusinessProfile } from '../src/services/business-profile';
import { getToolDefinitions } from '../src/services/tool-router.service';
import type { Product, SectorMeta } from '../src/types';

// The clinic vertical is data-driven; a business without one (the US auto
// shop) must get byte-identical prompts and tools. These snapshots were
// recorded before the vertical layer existed — if one changes, the US
// business's behaviour changed.

const META: SectorMeta = {
  name: 'Advanced VTech',
  model: 'service',
  categories: ['DIAGNOSTICS', 'MAINTENANCE', 'BRAKES'],
  hours: { mon: '7:30am–6pm', tue: '7:30am–6pm', wed: '7:30am–6pm', thu: '7:30am–6pm', fri: '7:30am–6pm', sat: '8am–4pm' },
  timezone: 'America/Chicago',
  currency: 'USD',
  address: '320 Lexington Drive, Buffalo Grove, IL 60089',
  phone: '(847) 777-5000',
  website: 'https://www.advancedvtech.com',
  about: 'Full-service auto and truck repair.',
};

const PRODUCTS: Product[] = [
  { id: 'avtech-oil', businessType: 'advanced_vtech', vendorId: 'v', vendorName: 'Advanced VTech', name: 'Oil & Filter Change and Lube', category: 'MAINTENANCE', type: 'SERVICE_APPOINTMENT', fulfillmentType: 'SERVICE_BOOKING', description: 'Price depends on the vehicle; the service advisor quotes it before any work starts.', priceCents: 0, originalPriceCents: 0, isActive: true, durationMinutes: null },
  { id: 'avtech-brakes', businessType: 'advanced_vtech', vendorId: 'v', vendorName: 'Advanced VTech', name: 'Brake Repair', category: 'BRAKES', type: 'SERVICE_APPOINTMENT', fulfillmentType: 'SERVICE_BOOKING', description: 'Brakes.', priceCents: 8900, originalPriceCents: 12000, isActive: true, durationMinutes: 90, upsellProductId: 'avtech-oil' },
];

describe('US auto shop is unchanged', () => {
  it('voice and chat rules', async () => {
    await expect(buildAgentRules('advanced_vtech', 'Advanced VTech', 'voice')).toMatchFileSnapshot('./__snapshots__/us-rules-voice.txt');
    await expect(buildAgentRules('advanced_vtech', 'Advanced VTech', 'chat')).toMatchFileSnapshot('./__snapshots__/us-rules-chat.txt');
  });
  it('business profile', async () => {
    await expect(buildBusinessProfile('advanced_vtech', META, PRODUCTS)).toMatchFileSnapshot('./__snapshots__/us-profile.txt');
  });
  it('tool definitions', async () => {
    await expect(JSON.stringify(getToolDefinitions('advanced_vtech', META), null, 2)).toMatchFileSnapshot('./__snapshots__/us-tools.json');
    await expect(JSON.stringify(agentTools('advanced_vtech', META, PRODUCTS.length), null, 2)).toMatchFileSnapshot('./__snapshots__/us-agent-tools.json');
  });
});
