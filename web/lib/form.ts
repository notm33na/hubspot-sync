// Demo form (R6, ARCHITECTURE §7 "Form"): validate, dedupe, then two resumable steps:
// (1) find or create the contact (never overwrite) and record it in Supabase (writer-records rule),
// (2) create the deal associated with that contact.
import crypto from 'node:crypto';
import { findOrCreateContact } from './hubspot';
import { refreshContact, type SyncDeps } from './sync/inbound';

export const PRODUCTS = {
  'oak-shelving': { label: 'Oak shelving kit', unitPrice: 189 },
  'steel-workbench': { label: 'Steel workbench', unitPrice: 425 },
  'storage-crates': { label: 'Storage crates (pack of 10)', unitPrice: 64 },
  'pallet-racking': { label: 'Pallet racking bay', unitPrice: 310 },
} as const;
export type ProductId = keyof typeof PRODUCTS;

export interface FormInput {
  firstName: string;
  lastName: string;
  email: string;
  product: ProductId;
  quantity: number;
  message: string;
}

export type Validation = { ok: true; value: FormInput } | { ok: false; errors: Record<string, string> };

const EMAIL = /^[a-z0-9._%+-]+@example\.com$/i;
const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

export function validateForm(raw: Record<string, unknown>): Validation {
  const errors: Record<string, string> = {};
  const value = {
    firstName: clean(raw.firstName, 50),
    lastName: clean(raw.lastName, 50),
    email: clean(raw.email, 120).toLowerCase(),
    product: clean(raw.product, 40) as ProductId,
    quantity: Number(raw.quantity),
    message: clean(raw.message, 500),
  };
  if (!value.firstName) errors.firstName = 'Enter a first name.';
  if (!value.lastName) errors.lastName = 'Enter a last name.';
  if (!EMAIL.test(value.email)) errors.email = 'Use an @example.com address: this demo only accepts fictional emails.';
  if (!(value.product in PRODUCTS)) errors.product = 'Choose a product.';
  if (!Number.isInteger(value.quantity) || value.quantity < 1 || value.quantity > 100) {
    errors.quantity = 'Enter a quantity from 1 to 100.';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** Same email and content map to the same key, so reloads and double clicks dedupe. */
export function formDedupeKey(f: FormInput): string {
  const normalized = [f.email, f.firstName, f.lastName, f.product, f.quantity, f.message]
    .map((v) => String(v).trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

interface Claim {
  submission_id: number;
  outcome: 'new' | 'resume' | 'in_progress' | 'done';
  contact_done: boolean;
  deal_done: boolean;
  hubspot_contact_id: number | null;
  hubspot_deal_id: number | null;
}

export type SubmitResult =
  | { status: 'done'; contactId: number; dealId: number; replayed: boolean }
  | { status: 'in_progress' };

export async function submitForm(f: FormInput, deps: SyncDeps): Promise<SubmitResult> {
  const [claim] = await deps.db.rpc<Claim[]>('claim_form_submission', { p_key: formDedupeKey(f), p_email: f.email });
  if (claim.outcome === 'in_progress') return { status: 'in_progress' };
  if (claim.outcome === 'done') {
    return { status: 'done', contactId: Number(claim.hubspot_contact_id), dealId: Number(claim.hubspot_deal_id), replayed: true };
  }

  const id = claim.submission_id;
  try {
    let contactId = claim.hubspot_contact_id;
    if (!claim.contact_done || contactId === null) {
      const { contact } = await findOrCreateContact(deps.request, {
        email: f.email,
        firstname: f.firstName,
        lastname: f.lastName,
      });
      // Writer-records rule: our create comes back as an echo webhook that Flow A skips,
      // so Supabase must learn about the contact here.
      await refreshContact(contact.id, deps);
      contactId = Number(contact.id);
      await deps.db.updateFormSubmission(id, { contact_done: true, hubspot_contact_id: contactId });
    }

    let dealId = claim.hubspot_deal_id;
    if (!claim.deal_done || dealId === null) {
      const product = PRODUCTS[f.product];
      const deal = await deps.request<{ id: string }>('POST', '/crm/v3/objects/deals', {
        properties: {
          dealname: `Fernhill demo: ${product.label} x ${f.quantity}`,
          amount: String(product.unitPrice * f.quantity),
          pipeline: 'default',
          dealstage: 'appointmentscheduled',
          ...(f.message ? { description: f.message } : {}),
        },
        associations: [
          // 3 = HubSpot-defined deal-to-contact association.
          { to: { id: String(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] },
        ],
      });
      dealId = Number(deal.id);
    }

    await deps.db.updateFormSubmission(id, {
      deal_done: true, hubspot_deal_id: dealId, status: 'done', last_error: null,
    });
    await deps.db.log({ direction: 'form', object_id: String(contactId), action: 'submission', outcome: `deal ${dealId}` });
    return { status: 'done', contactId, dealId, replayed: false };
  } catch (err) {
    await deps.db.updateFormSubmission(id, { status: 'failed', last_error: (err as Error).message.slice(0, 500) });
    await deps.db.log({ direction: 'form', object_id: null, action: 'submission', outcome: 'failed' });
    throw err;
  }
}
