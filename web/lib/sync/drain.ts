// Job runner (ARCHITECTURE §6): claim a few rows at a time, process one by one, record the outcome.
import type { InboxRow, OutboxRow } from '../db';
import { log } from '../log';
import { subrequestsLeft } from '../runtime';
import { processInboxEvent, type JobResult, type SyncDeps } from './inbound';
import { processOutboxJob } from './outbound';

const BATCH = 5;
// Workers Free: 50 subrequests per invocation. Worst case for one row is ~15 (create + link a contact
// with every HubSpot call retried 3 times, then finish_job and the log line), so a row only starts with
// 16 left, and a claim needs one more. A typical row costs ~4, so a drain still handles ~8 rows.
export const ROW_SUBREQUESTS = 16;
const CLAIM_SUBREQUESTS = ROW_SUBREQUESTS + 1;

export interface DrainStats {
  done: number;
  skipped: number;
  requeued: number;
  failed: number;
  dead: number;
}

export async function drainInbox(deps: SyncDeps, deadline: number): Promise<DrainStats> {
  return drain<InboxRow>('inbox', 'claim_inbox', deps, deadline, (row) => processInboxEvent(row.payload, deps),
    (row) => String(row.payload.objectId));
}

export async function drainOutbox(deps: SyncDeps, deadline: number): Promise<DrainStats> {
  return drain<OutboxRow>('outbox', 'claim_outbox', deps, deadline, (row) => processOutboxJob(row, deps),
    (row) => row.customer_id);
}

async function drain<T extends { id: number }>(
  queue: 'inbox' | 'outbox',
  claimFn: string,
  deps: SyncDeps,
  deadline: number,
  process: (row: T) => Promise<JobResult>,
  objectId: (row: T) => string,
): Promise<DrainStats> {
  const stats: DrainStats = { done: 0, skipped: 0, requeued: 0, failed: 0, dead: 0 };
  const direction = queue === 'inbox' ? 'inbound' : 'outbound';

  // Claim only while there is time and subrequest budget left. Every claimed row is finished, failed, or released.
  while (Date.now() < deadline && subrequestsLeft() >= CLAIM_SUBREQUESTS) {
    const rows = await deps.db.rpc<T[]>(claimFn, { p_limit: BATCH });
    if (!rows?.length) break;

    for (const [i, row] of rows.entries()) {
      const outOfTime = Date.now() >= deadline;
      if (outOfTime || subrequestsLeft() < ROW_SUBREQUESTS) {
        // Hand unstarted rows back now instead of leaving them stuck for 5 minutes; the next drain takes them.
        const unstarted = rows.slice(i).map((r) => r.id);
        await deps.db.rpc('release_jobs', { p_queue: queue, p_ids: unstarted });
        log('jobs_released', { queue, count: unstarted.length, reason: outOfTime ? 'deadline' : 'subrequests' });
        return stats;
      }
      try {
        const result = await process(row);
        if (result.status !== 'requeued') {
          await deps.db.rpc('finish_job', { p_queue: queue, p_id: row.id, p_status: result.status });
        }
        stats[result.status]++;
        await deps.db.log({ direction, object_id: result.objectId ?? objectId(row), action: result.action, outcome: result.outcome });
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        const permanent = (err as { permanent?: boolean }).permanent === true;
        const status = await deps.db.rpc<string>('fail_job', {
          p_queue: queue, p_id: row.id, p_error: message, p_permanent: permanent,
        });
        stats[status === 'dead' ? 'dead' : 'failed']++;
        log('job_failed', { queue, id: row.id, status, error: message });
        await deps.db.log({ direction, object_id: objectId(row), action: 'error', outcome: status });
      }
    }
  }
  return stats;
}
