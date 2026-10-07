// Orders card data, called from HubSpot via hubspot.fetch (ARCHITECTURE §7 "Card").
// The query string (which HubSpot extends with userEmail) is never logged.
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { publicUrl, verifyHubSpotV3 } from '@/lib/signature';

const PAGE_SIZE = 20;

interface OrderRow {
  order_number: string;
  ordered_at: string;
  total_cents: number;
  currency: string;
  status: string;
}

export async function GET(request: Request): Promise<Response> {
  const url = publicUrl(request);
  const verified = verifyHubSpotV3({
    method: 'GET',
    url,
    rawBody: '',
    headers: request.headers,
    secret: env('HUBSPOT_CLIENT_SECRET'),
  });
  if (!verified.ok) {
    log('card_rejected', { reason: verified.reason });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const params = new URL(url).searchParams;
  if (params.get('portalId') !== env('HUBSPOT_PORTAL_ID')) {
    log('card_rejected', { reason: 'wrong portal' });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const contactId = Number(params.get('contactId'));
  const page = Math.max(0, Math.floor(Number(params.get('page') ?? '0')) || 0);
  if (!Number.isSafeInteger(contactId) || contactId <= 0) {
    return Response.json({ error: 'contactId required' }, { status: 400 });
  }

  // Ask for one extra row to know whether a next page exists.
  const rows = await db().rpc<OrderRow[]>('orders_for_contact', {
    p_contact_id: contactId,
    p_limit: PAGE_SIZE + 1,
    p_offset: page * PAGE_SIZE,
  });

  log('card_orders', { contactId, page, count: Math.min(rows.length, PAGE_SIZE) });
  return Response.json({
    orders: rows.slice(0, PAGE_SIZE).map((o) => ({
      orderNumber: o.order_number,
      date: o.ordered_at.slice(0, 10),
      total: o.total_cents / 100,
      currency: o.currency.trim(),
      status: o.status,
    })),
    nextPage: rows.length > PAGE_SIZE ? page + 1 : null,
  });
}
