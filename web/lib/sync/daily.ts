// Daily job (ARCHITECTURE §10): prune, sweep queues, catch missed updates and deletes.
// One bad contact is counted and logged, never allowed to stop the run.
import { CONTACT_MODIFIED, OWNED_PROPERTIES, type HubSpotContact } from '../hubspot';
import { log } from '../log';
import { drainInbox, drainOutbox } from './drain';
import { applyContact, refreshContact, type SyncDeps } from './inbound';

const WINDOW_MS = 48 * 60 * 60 * 1000;
const PAGE = 100;

export interface DailyStats {
  pruned: unknown;
  recentContacts: number;
  recentApplied: Record<string, number>;
  checkedLinked: number;
  missingResolved: Record<string, number>;
  errors: number;
  timedOut: boolean;
}

interface SearchPage {
  results: HubSpotContact[];
  paging?: { next?: { after: string } };
}

export async function runDaily(deps: SyncDeps, deadline: number, now = Date.now()): Promise<DailyStats> {
  const stats: DailyStats = {
    pruned: null, recentContacts: 0, recentApplied: {}, checkedLinked: 0, missingResolved: {}, errors: 0, timedOut: false,
  };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const outOfTime = () => (Date.now() >= deadline ? ((stats.timedOut = true), true) : false);
  const guarded = async (contactId: string, step: string, fn: () => Promise<string>, into: Record<string, number>) => {
    try {
      bump(into, await fn());
    } catch (err) {
      stats.errors++;
      log('daily_contact_failed', { step, contactId, error: (err as Error).message });
    }
  };

  // 1. Retention first: cheap, and must not be skipped by a later timeout.
  stats.pruned = await deps.db.rpc('prune_old_rows');

  // 2. Retry anything due (the per-minute drain normally gets there first).
  await drainOutbox(deps, deadline);
  await drainInbox(deps, deadline);

  // 3. Missed updates: contacts modified in the last 48 h. This path ignores changeSource on purpose.
  let after: string | undefined;
  do {
    if (outOfTime()) return stats;
    const page = await deps.request<SearchPage>('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: CONTACT_MODIFIED, operator: 'GTE', value: String(now - WINDOW_MS) }] }],
      sorts: [{ propertyName: CONTACT_MODIFIED, direction: 'ASCENDING' }],
      properties: [...OWNED_PROPERTIES, CONTACT_MODIFIED],
      limit: PAGE,
      ...(after ? { after } : {}),
    });
    for (const c of page.results) {
      stats.recentContacts++;
      await guarded(c.id, 'recent', () => applyContact(c, deps), stats.recentApplied);
    }
    after = page.paging?.next?.after;
  } while (after);

  // 4. Missed deletes and merges: every linked contact must still exist under its ID.
  let lastId = 0;
  for (;;) {
    if (outOfTime()) return stats;
    const ids = await deps.db.linkedContactIds(lastId, PAGE);
    if (ids.length === 0) break;
    lastId = ids[ids.length - 1];
    const found = await deps.request<{ results: { id: string }[] }>('POST', '/crm/v3/objects/contacts/batch/read', {
      properties: ['hs_object_id'],
      inputs: ids.map((id) => ({ id: String(id) })),
    });
    stats.checkedLinked += ids.length;
    const present = new Set(found.results.map((r) => r.id));
    for (const id of ids.filter((id) => !present.has(String(id)))) {
      // A single GET resolves it: 404 -> soft delete, different id -> merge.
      await guarded(String(id), 'missing', () => refreshContact(String(id), deps), stats.missingResolved);
    }
  }
  return stats;
}
