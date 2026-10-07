// Vercel cron, once a day (Hobby limit). Vercel sends `Authorization: Bearer $CRON_SECRET`.
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { hasBearer } from '@/lib/signature';
import { runDaily } from '@/lib/sync/daily';
import { syncDeps } from '@/lib/sync/deps';

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  if (!hasBearer(request, env('CRON_SECRET'))) {
    return new Response('unauthorized', { status: 401 });
  }
  const deps = syncDeps();
  try {
    const stats = await runDaily(deps, Date.now() + 240_000);
    log('daily', { ...stats });
    await deps.db.log({
      direction: 'system', object_id: null, action: 'daily',
      outcome: `${stats.recentContacts} recent, ${stats.checkedLinked} checked${stats.timedOut ? ', timed out' : ''}`,
    });
    return Response.json(stats);
  } catch (err) {
    log('daily_failed', { error: (err as Error).message });
    await deps.db.log({ direction: 'system', object_id: null, action: 'daily', outcome: 'failed' });
    return Response.json({ error: 'daily job failed' }, { status: 500 });
  }
}
