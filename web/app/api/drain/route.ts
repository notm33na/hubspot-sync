// Called by Supabase (outbox trigger and per-minute pg_cron) with the Vault bearer secret (ARCHITECTURE §6).
// Answers 202 at once and drains in the background: pg_net gives up after 5 s, and the caller needs
// no result. Concurrent drains are safe because claiming uses SKIP LOCKED.
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { BACKGROUND_DEADLINE_MS, waitUntil } from '@/lib/runtime';
import { hasBearer } from '@/lib/signature';
import { syncDeps } from '@/lib/sync/deps';
import { drainInbox, drainOutbox, type DrainStats } from '@/lib/sync/drain';

const total = (s: DrainStats) => s.done + s.skipped + s.requeued + s.failed + s.dead;

export async function POST(request: Request): Promise<Response> {
  if (!hasBearer(request, env('DRAIN_SECRET'))) {
    log('drain_rejected');
    return new Response('unauthorized', { status: 401 });
  }

  const deps = syncDeps();
  const deadline = Date.now() + BACKGROUND_DEADLINE_MS;
  waitUntil(
    (async () => {
      const outbox = await drainOutbox(deps, deadline);
      const inbox = await drainInbox(deps, deadline);
      // Quiet ticks (nothing to do) are not logged, to keep the log readable.
      if (total(outbox) + total(inbox) > 0) log('drain', { outbox, inbox });
    })().catch((err) => log('drain_failed', { error: (err as Error).message })),
  );
  return new Response(null, { status: 202 });
}
