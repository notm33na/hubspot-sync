// HubSpot webhooks -> sync_inbox (ARCHITECTURE §4 "Ingest").
import { waitUntil } from '@vercel/functions';
import type { HubSpotEvent, SyncLogEntry } from '@/lib/db';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { publicUrl, verifyHubSpotV3 } from '@/lib/signature';
import { syncDeps } from '@/lib/sync/deps';
import { drainInbox } from '@/lib/sync/drain';
import { dedupeKey } from '@/lib/sync/inbound';

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const verified = verifyHubSpotV3({
    method: 'POST',
    url: publicUrl(request),
    rawBody,
    headers: request.headers,
    secret: env('HUBSPOT_CLIENT_SECRET'),
  });
  if (!verified.ok) {
    log('webhook_rejected', { reason: verified.reason });
    return new Response('unauthorized', { status: 401 });
  }

  let events: HubSpotEvent[];
  try {
    const parsed = JSON.parse(rawBody);
    events = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const deps = syncDeps();
  let inserted: number;
  try {
    inserted = await deps.db.insertInboxEvents(events.map((e) => ({ dedupe_key: dedupeKey(e), payload: e })));
    log('webhook_received', {
      count: events.length,
      inserted,
      types: [...new Set(events.map((e) => e.subscriptionType))],
    });
  } catch (err) {
    // Only a failed insert makes HubSpot retry the batch.
    log('webhook_insert_failed', { error: (err as Error).message });
    return new Response('retry', { status: 503 });
  }

  // Respond inside HubSpot's 5 s timeout; process afterwards. The per-minute drain covers a cut-short run.
  const duplicates = events.length - inserted;
  waitUntil(
    (async () => {
      // Make de-duplication visible on /activity (a HubSpot retry, or a replayed request).
      if (duplicates > 0) await deps.db.log(duplicateLogEntry(events, duplicates));
      log('webhook_drain', { ...(await drainInbox(deps, Date.now() + 35_000)) });
    })().catch((err) => log('webhook_drain_failed', { error: (err as Error).message })),
  );
  return new Response(null, { status: 204 });
}

function duplicateLogEntry(events: HubSpotEvent[], duplicates: number): SyncLogEntry {
  const objects = new Set(events.map((e) => String(e.objectId)));
  return {
    direction: 'inbound',
    object_id: objects.size === 1 ? [...objects][0] : null,
    action: 'webhook',
    outcome: `${duplicates} duplicate${duplicates === 1 ? '' : 's'} ignored`,
  };
}
