// Flow A — HubSpot -> Supabase (ARCHITECTURE §4).
import type { HubSpotEvent, SyncDb } from '../db';
import { CONTACT_MODIFIED, getContact, isDemoEmail, type HubSpotContact, type RequestFn } from '../hubspot';

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

// eventId alone is not guaranteed unique, so it is combined with the fields a retry repeats unchanged.
export function dedupeKey(e: HubSpotEvent): string {
  return [e.eventId ?? '', e.subscriptionId ?? '', e.objectId, e.propertyName ?? '', e.occurredAt ?? ''].join(':');
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
    // Stamp with HubSpot's deletion time, so a restore that happened later still wins.
    const outcome = await deps.db.rpc<string>('apply_hubspot_delete', {
      p_contact_id: e.objectId,
      ...(e.occurredAt ? { p_deleted_at: new Date(e.occurredAt).toISOString() } : {}),
    });
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
    // 404: "gone as of now" is exactly what we observed, so the default (now) is the right stamp.
    return deps.db.rpc<string>('apply_hubspot_delete', { p_contact_id: Number(id) });
  }
  if (contact.id !== id) {
    // HubSpot answered with the surviving record of a merge.
    await deps.db.rpc('apply_hubspot_merge', { p_old_id: Number(id), p_new_id: Number(contact.id) });
  }
  return applyContact(contact, deps);
}

/**
 * Apply a fetched contact. Contacts outside the demo domain are never stored: if one is already
 * known (e.g. its email changed), it is soft-deleted and its personal data cleared.
 */
export async function applyContact(contact: HubSpotContact, deps: SyncDeps): Promise<string> {
  if (!isDemoEmail(contact.properties.email)) {
    const modified = contact.properties[CONTACT_MODIFIED];
    const outcome = await deps.db.rpc<string>('apply_hubspot_delete', {
      p_contact_id: Number(contact.id),
      ...(modified ? { p_deleted_at: modified } : {}),
    });
    return outcome === 'deleted' ? 'cleared (not demo data)' : 'ignored (not demo data)';
  }
  return deps.db.rpc<string>('apply_hubspot_contact', applyArgs(contact));
}

/**
 * Arguments for apply_hubspot_contact. HubSpot's own modification time drives the out-of-order guard,
 * so it is required: falling back to the server clock would let a late, older event win.
 */
export function applyArgs(contact: HubSpotContact): Record<string, unknown> {
  const p = contact.properties;
  const modified = p[CONTACT_MODIFIED];
  if (!modified) throw new Error(`contact ${contact.id} has no ${CONTACT_MODIFIED}`);
  return {
    p_contact_id: Number(contact.id),
    p_email: p.email ?? null,
    p_first_name: p.firstname ?? null,
    p_last_name: p.lastname ?? null,
    p_phone: p.phone ?? null,
    p_lifecycle_stage: p.lifecyclestage ?? null,
    p_modified: modified,
  };
}
