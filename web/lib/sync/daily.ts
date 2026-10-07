// Daily job (ARCHITECTURE §10): sweep queues, catch missed updates and deletes, prune.
import { CONTACT_MODIFIED, OWNED_PROPERTIES, type HubSpotContact } from '../hubspot';
import { drainInbox, drainOutbox } from './drain';
import { applyArgs, refreshContact, type SyncDeps } from './inbound';

const WINDOW_MS = 48 * 60 * 60 * 1000;
const PAGE = 100;

export interface DailyStats {
  recentContacts: number;
  recentApplied: Record<string, number>;
  checkedLinked: number;
  missingResolved: Record<string, number>;
  pruned: unknown;
  timedOut: boolean;
}

interface SearchPage {
  results: HubSpotContact[];
  paging?: { next?: { after: string } };
}

export async function runDaily(deps: SyncDeps, deadline: number, now = Date.now()): Promise<DailyStats> {
  const stats: DailyStats = {
    recentContacts: 0, recentApplied: {}, checkedLinked: 0, missingResolved: {}, pruned: null, timedOut: false,
  };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const outOfTime = () => (Date.now() >= deadline ? ((stats.timedOut = true), true) : false);

  // 1. Retry anything due (the per-minute drain normally gets there first).
  await drainOutbox(deps, deadline);
  await drainInbox(deps, deadline);

  // 2. Missed updates: contacts modified in the last 48 h. This path ignores changeSource on purpose.
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
      const outcome = await deps.db.rpc<string>('apply_hubspot_contact', applyArgs(c));
      stats.recentContacts++;
      bump(stats.recentApplied, outcome);
    }
    after = page.paging?.next?.after;
  } while (after);

  // 3. Missed deletes and merges: every linked contact must still exist under its ID.
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
      bump(stats.missingResolved, await refreshContact(String(id), deps));
    }
  }

  // 4. Retention.
  stats.pruned = await deps.db.rpc('prune_old_rows');
  return stats;
}
