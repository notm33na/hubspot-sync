// Called by Supabase (outbox trigger and per-minute pg_cron) with the Vault bearer secret (ARCHITECTURE §6).
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { hasBearer } from '@/lib/signature';
import { syncDeps } from '@/lib/sync/deps';
import { drainInbox, drainOutbox } from '@/lib/sync/drain';

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (!hasBearer(request, env('DRAIN_SECRET'))) {
    return new Response('unauthorized', { status: 401 });
  }

  const deps = syncDeps();
  const deadline = Date.now() + 45_000;
  const outbox = await drainOutbox(deps, deadline);
  const inbox = await drainInbox(deps, deadline);

  // Quiet ticks (nothing to do) are not logged, to keep the log readable.
  const total = (s: typeof outbox) => s.done + s.skipped + s.requeued + s.failed + s.dead;
  if (total(outbox) + total(inbox) > 0) log('drain', { outbox, inbox });

  return Response.json({ outbox, inbox });
}
