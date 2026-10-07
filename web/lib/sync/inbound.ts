// Flow A — HubSpot -> Supabase (ARCHITECTURE §4).
import type { HubSpotEvent, SyncDb } from '../db';
import { getContact, type RequestFn } from '../hubspot';

export interface SyncDeps {
  db: SyncDb;
  request: RequestFn;
  appId: string;
}

export interface JobResult {
  status: 'done' | 'skipped' | 'requeued';
  action: string;
  outcome: string;
}

export function dedupeKey(e: HubSpotEvent): string {
  if (e.eventId !== undefined) return `e:${e.eventId}`;
  return `s:${e.subscriptionId}:${e.objectId}:${e.propertyName ?? ''}:${e.occurredAt}`;
}

function isContactEvent(e: HubSpotEvent): boolean {
  return e.subscriptionType.startsWith('contact.') || e.objectTypeId === '0-1';
}

export async function processInboxEvent(e: HubSpotEvent, deps: SyncDeps): Promise<JobResult> {
  const kind = e.subscriptionType.split('.').pop() ?? '';
  if (!isContactEvent(e)) return { status: 'skipped', action: kind, outcome: 'not a contact event' };

  // Echo rule: our own writes come back with our app as the source. The writer-records rule
  // means Supabase already has that change, so the event carries nothing new.
  if (e.changeSource === 'INTEGRATION' && String(e.sourceId) === deps.appId) {
    return { status: 'skipped', action: kind, outcome: 'own write (echo)' };
  }

  if (kind === 'deletion' || kind === 'privacyDeletion') {
    const outcome = await deps.db.rpc<string>('apply_hubspot_delete', { p_contact_id: e.objectId });
    return { status: 'done', action: kind, outcome };
  }

  if (kind === 'merge') {
    // A merge can produce a brand-new record (newObjectId); otherwise the primary survives.
    const survivor = e.newObjectId ?? e.primaryObjectId ?? e.objectId;
    const absorbed = new Set([...(e.mergedObjectIds ?? []), e.primaryObjectId, e.objectId]);
    for (const id of absorbed) {
      if (id !== undefined && id !== survivor) {
        await deps.db.rpc('apply_hubspot_merge', { p_old_id: id, p_new_id: survivor });
      }
    }
    return { status: 'done', action: kind, outcome: await refreshContact(String(survivor), deps) };
  }

  // creation, propertyChange, restore: never trust the event's value or order — fetch current state.
  return { status: 'done', action: kind, outcome: await refreshContact(String(e.objectId), deps) };
}

/** Fetch a contact's current state and apply it. Also used after linking and by the daily reconcile. */
export async function refreshContact(id: string, deps: SyncDeps): Promise<string> {
  const contact = await getContact(deps.request, id);
  if (!contact) {
    return deps.db.rpc<string>('apply_hubspot_delete', { p_contact_id: Number(id) });
  }
  if (contact.id !== id) {
    // HubSpot answered with the surviving record of a merge.
    await deps.db.rpc('apply_hubspot_merge', { p_old_id: Number(id), p_new_id: Number(contact.id) });
  }
  const p = contact.properties;
  return deps.db.rpc<string>('apply_hubspot_contact', {
    p_contact_id: Number(contact.id),
    p_email: p.email ?? null,
    p_first_name: p.firstname ?? null,
    p_last_name: p.lastname ?? null,
    p_phone: p.phone ?? null,
    p_lifecycle_stage: p.lifecyclestage ?? null,
    p_modified: p.hs_lastmodifieddate ?? new Date().toISOString(),
  });
}
