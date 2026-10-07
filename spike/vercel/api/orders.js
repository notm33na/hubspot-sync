// Called from the HubSpot app card via hubspot.fetch(). Returns hard-coded fake orders.
import { verifyV3, publicUrl } from '../lib/hubspot-signature.js';

const FAKE_ORDERS = [
  { id: 'ORD-1001', date: '2026-09-14', total: 129.0, status: 'Shipped' },
  { id: 'ORD-1002', date: '2026-09-28', total: 54.5, status: 'Processing' },
  { id: 'ORD-1003', date: '2026-10-02', total: 310.25, status: 'Delivered' },
];

export async function GET(request) {
  const rawBody = await request.text();
  const url = publicUrl(request);
  const result = verifyV3({
    method: 'GET',
    url,
    rawBody,
    headers: request.headers,
    secret: process.env.CLIENT_SECRET,
  });

  const params = new URL(url).searchParams;
  console.log('ORDERS_REQUEST', JSON.stringify({
    verified: result.ok,
    reason: result.reason,
    portalId: params.get('portalId'),
    contactId: params.get('contactId'),
  }));

  if (!result.ok) {
    return Response.json({ error: 'unauthorized', reason: result.reason }, { status: 401 });
  }
  return Response.json({
    contactId: params.get('contactId'),
    source: 'fake data (spike)',
    orders: FAKE_ORDERS,
  });
}
