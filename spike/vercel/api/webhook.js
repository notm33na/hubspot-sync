// HubSpot webhook receiver. Logs each event so we can see changeSource / sourceId.
import { verifyV3, publicUrl } from '../lib/hubspot-signature.js';

export async function POST(request) {
  const rawBody = await request.text();
  const result = verifyV3({
    method: 'POST',
    url: publicUrl(request),
    rawBody,
    headers: request.headers,
    secret: process.env.CLIENT_SECRET,
  });

  if (!result.ok) {
    console.log('WEBHOOK_REJECTED', JSON.stringify({ reason: result.reason }));
    return new Response('unauthorized', { status: 401 });
  }

  let events;
  try {
    events = JSON.parse(rawBody);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // One log line per request: the CLI log stream can drop later lines of an invocation.
  const batch = Array.isArray(events) ? events : [events];
  console.log('WEBHOOK_BATCH', JSON.stringify({ count: batch.length, events: batch }));
  return new Response(null, { status: 204 });
}
