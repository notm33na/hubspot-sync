import { describe, expect, it, vi } from 'vitest';
import { HubSpotError, type RequestFn } from './hubspot';
import { dealRef, formDedupeKey, submitForm, validateForm, type FormInput } from './form';
import { contact, deps, fakeDb } from './testing/fakes';

const valid: FormInput = {
  firstName: 'Jordan', lastName: 'Reed', email: 'jordan@example.com',
  product: 'steel-workbench', quantity: 2, message: 'Need by Friday',
};

const claim = (c: Record<string, unknown>) => [{
  submission_id: 11, outcome: 'new', contact_done: false, deal_done: false,
  hubspot_contact_id: null, hubspot_deal_id: null, ...c,
}];

describe('validateForm', () => {
  it('accepts a complete @example.com submission and normalizes it', () => {
    const r = validateForm({ ...valid, email: ' Jordan@Example.com ', quantity: '2' });
    expect(r).toMatchObject({ ok: true, value: { email: 'jordan@example.com', quantity: 2 } });
  });

  it('rejects real-looking emails, unknown products and bad quantities', () => {
    const r = validateForm({ ...valid, email: 'jordan@example.org', product: 'rocket', quantity: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['email', 'product', 'quantity']);
  });
});

describe('formDedupeKey', () => {
  it('ignores case and spacing but not content', () => {
    expect(formDedupeKey({ ...valid, firstName: ' JORDAN ' })).toBe(formDedupeKey(valid));
    expect(formDedupeKey({ ...valid, quantity: 3 })).not.toBe(formDedupeKey(valid));
  });
});

describe('submitForm', () => {
  it('creates contact, records it in Supabase, then creates the associated deal', async () => {
    const { db, rpc } = fakeDb({ claim_form_submission: claim({}), apply_hubspot_contact: 'inserted' });
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path.includes('idProperty=email')) throw new HubSpotError(404, 'not found', true);
      if (method === 'POST' && path === '/crm/v3/objects/contacts') return contact('500');
      if (method === 'GET') return contact('500');
      if (method === 'POST' && path === '/crm/v3/objects/deals') return { id: '900' };
      throw new Error(`unexpected ${method} ${path}`);
    }) as unknown as RequestFn;

    const r = await submitForm(valid, deps(db, request));
    expect(r).toEqual({ status: 'done', contactId: 500, dealId: 900, replayed: false });
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_contact', expect.objectContaining({ p_contact_id: 500 }));
    expect(request).toHaveBeenCalledWith('POST', '/crm/v3/objects/deals', expect.objectContaining({
      properties: expect.objectContaining({ amount: '850', dealstage: 'appointmentscheduled' }),
      associations: [expect.objectContaining({ to: { id: '500' } })],
    }));
    expect(db.updateFormSubmission).toHaveBeenLastCalledWith(11, expect.objectContaining({ status: 'done', hubspot_deal_id: 900 }));
  });

  it('returns the stored result for a completed duplicate without calling HubSpot', async () => {
    const { db } = fakeDb({ claim_form_submission: claim({ outcome: 'done', hubspot_contact_id: 5, hubspot_deal_id: 9 }) });
    const request = vi.fn() as unknown as RequestFn;
    expect(await submitForm(valid, deps(db, request))).toEqual({ status: 'done', contactId: 5, dealId: 9, replayed: true });
    expect(request).not.toHaveBeenCalled();
  });

  it('reports in_progress for a concurrent duplicate', async () => {
    const { db } = fakeDb({ claim_form_submission: claim({ outcome: 'in_progress' }) });
    expect(await submitForm(valid, deps(db, vi.fn() as unknown as RequestFn))).toEqual({ status: 'in_progress' });
  });

  it('resumes after a failure: skips the finished contact step, creates only the deal', async () => {
    const { db } = fakeDb({ claim_form_submission: claim({ outcome: 'resume', contact_done: true, hubspot_contact_id: 500 }) });
    const request = vi.fn(async (_m: string, path: string) =>
      path.endsWith('/search') ? { results: [] } : { id: '901' }) as unknown as RequestFn;
    const r = await submitForm(valid, deps(db, request));
    expect(r).toMatchObject({ dealId: 901 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('POST', '/crm/v3/objects/deals', expect.objectContaining({
      properties: expect.objectContaining({ dealname: expect.stringContaining(`(ref ${dealRef(valid, 11)})`) }),
    }));
  });

  it('on resume, reuses a deal an earlier attempt created but never recorded', async () => {
    const { db } = fakeDb({ claim_form_submission: claim({ outcome: 'resume', contact_done: true, hubspot_contact_id: 500 }) });
    const request = vi.fn(async () => ({
      results: [{ id: '777', properties: { dealname: `Fernhill demo: x (ref ${dealRef(valid, 11)})` } }],
    })) as unknown as RequestFn;
    const r = await submitForm(valid, deps(db, request));
    expect(r).toMatchObject({ dealId: 777 });
    expect(request).not.toHaveBeenCalledWith('POST', '/crm/v3/objects/deals', expect.anything());
  });

  it('marks the submission failed and rethrows when HubSpot fails', async () => {
    const { db } = fakeDb({ claim_form_submission: claim({ outcome: 'resume', contact_done: true, hubspot_contact_id: 500 }) });
    const request = vi.fn(async () => { throw new HubSpotError(503, 'unavailable', false); }) as unknown as RequestFn;
    await expect(submitForm(valid, deps(db, request))).rejects.toThrow('unavailable');
    expect(db.updateFormSubmission).toHaveBeenCalledWith(11, expect.objectContaining({ status: 'failed' }));
  });
});
