// Flow B — Supabase -> HubSpot (ARCHITECTURE §5).
import type { OutboxRow } from '../db';
import { findOrCreateContact, HubSpotError, isDemoEmail } from '../hubspot';
import { refreshContact, type JobResult, type SyncDeps } from './inbound';

interface Rollup {
  hubspot_contact_id: number | null;
  is_deleted: boolean;
  total_orders: number;
  lifetime_value_cents: number;
  last_order_date: string | null;
}

export class PermanentJobError extends Error {
  readonly permanent = true;
}

const MAX_LINK_WAIT_MS = 30 * 60 * 1000;

export async function processOutboxJob(job: OutboxRow, deps: SyncDeps): Promise<JobResult> {
  return job.kind === 'rollup' ? rollup(job, deps) : linkContact(job, deps);
}

async function rollup(job: OutboxRow, deps: SyncDeps): Promise<JobResult> {
  const [r] = await deps.db.rpc<Rollup[]>('compute_rollup', { p_customer: job.customer_id });
  if (!r || r.is_deleted) return { status: 'skipped', action: 'rollup', outcome: 'customer missing or deleted' };

  if (r.hubspot_contact_id === null) {
    // Not linked yet (link_contact still pending): wait without using up attempts, but not forever:
    // if linking itself is parked, this roll-up must surface as dead rather than loop silently.
    const ageMs = job.created_at ? Date.now() - Date.parse(job.created_at) : 0;
    if (ageMs > MAX_LINK_WAIT_MS) throw new PermanentJobError('customer still not linked to HubSpot after 30 minutes');
    const outcome = await deps.db.rpc<string>('requeue_outbox', { p_id: job.id, p_delay_seconds: 60 });
    return { status: 'requeued', action: 'rollup', outcome: `not linked yet, ${outcome}` };
  }

  try {
    await deps.request('PATCH', `/crm/v3/objects/contacts/${r.hubspot_contact_id}`, {
      properties: {
        demo_total_orders: String(r.total_orders),
        demo_lifetime_value: (r.lifetime_value_cents / 100).toFixed(2),
        demo_last_order_date: r.last_order_date ?? '',
      },
    });
  } catch (err) {
    // Contact gone in HubSpot: Flow A (or the daily check) will soft-delete the customer.
    if (err instanceof HubSpotError && err.status === 404) {
      return { status: 'skipped', action: 'rollup', outcome: 'contact not found in HubSpot' };
    }
    throw err;
  }
  return { status: 'done', action: 'rollup', outcome: `${r.total_orders} orders` };
}

async function linkContact(job: OutboxRow, deps: SyncDeps): Promise<JobResult> {
  const c = await deps.db.getCustomer(job.customer_id);
  if (!c || c.deleted_at) return { status: 'skipped', action: 'link_contact', outcome: 'customer missing or deleted' };
  if (c.hubspot_contact_id !== null) return { status: 'skipped', action: 'link_contact', outcome: 'already linked' };
  if (!c.email) throw new PermanentJobError('customer has no email to link by');
  if (!isDemoEmail(c.email)) throw new PermanentJobError('customer email is outside the demo domain');

  const { contact, created } = await findOrCreateContact(deps.request, {
    email: c.email,
    firstname: c.first_name,
    lastname: c.last_name,
  });
  await deps.db.rpc('link_customer', { p_customer: c.id, p_contact_id: Number(contact.id) });
  // HubSpot now owns the identity fields: pull its values back.
  await refreshContact(contact.id, deps);
  return { status: 'done', action: 'link_contact', outcome: created ? 'created contact' : 'linked existing contact' };
}
