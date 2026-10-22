// Orders card: a request HubSpot signed for the public custom domain is accepted end to end.
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const SECRET = 'test-client-secret';
const BASE = 'https://fernhill.mediaandsoftwaremanager.com/api/card/orders';
const rpc = vi.fn(async () => [{ order_number: 'FH-1', ordered_at: '2026-10-04T10:00:00Z', total_cents: 5517, currency: 'USD', status: 'paid' }]);
vi.mock('@/lib/db', () => ({ db: () => ({ rpc }) }));

beforeAll(() => {
  Object.assign(process.env, { HUBSPOT_CLIENT_SECRET: SECRET, HUBSPOT_PORTAL_ID: '123' });
});

// What HubSpot sends: the query is percent-encoded, the signature covers the decoded URI.
function hubspotGet(query: string, host = 'fernhill.mediaandsoftwaremanager.com'): Request {
  const url = `${BASE}?${query}`;
  const ts = String(Date.now());
  const signed = url.replace('fernhill.mediaandsoftwaremanager.com', host).replace(/%40/g, '@');
  const sig = crypto.createHmac('sha256', SECRET).update(`GET${signed}${ts}`, 'utf8').digest('base64');
  return new Request(url, { headers: { 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': ts } });
}

describe('card orders route on the custom domain', () => {
  it('accepts a signed request and returns the orders', async () => {
    const { GET } = await import('./route');
    const res = await GET(hubspotGet('contactId=42&portalId=123&userEmail=a%40example.org&userId=1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orders: [{ orderNumber: 'FH-1', date: '2026-10-04', total: 55.17, currency: 'USD', status: 'paid' }],
      nextPage: null,
    });
    expect(rpc).toHaveBeenCalledWith('orders_for_contact', { p_contact_id: 42, p_limit: 21, p_offset: 0 });
  });

  it('rejects a request signed for a different host', async () => {
    const { GET } = await import('./route');
    const res = await GET(hubspotGet('contactId=42&portalId=123', 'fernhill-order-sync.vercel.app'));
    expect(res.status).toBe(401);
  });
});
