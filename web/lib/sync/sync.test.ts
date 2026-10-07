import { describe, expect, it, vi } from 'vitest';
import type { HubSpotEvent } from '../db';
import { HubSpotError, type RequestFn } from '../hubspot';
import { APP_ID, contact, deps, fakeDb } from '../testing/fakes';
import { dedupeKey, processInboxEvent } from './inbound';
import { processOutboxJob } from './outbound';
import { drainOutbox } from './drain';

const event = (e: Partial<HubSpotEvent>): HubSpotEvent => ({
  subscriptionType: 'object.propertyChange', objectTypeId: '0-1', objectId: 100,
  changeSource: 'CRM_UI', sourceId: 'userId:1', eventId: 1, ...e,
});

describe('dedupeKey', () => {
  it('combines eventId with the fields a retry repeats, so equal eventIds on different events stay distinct', () => {
    const a = event({ eventId: 42, subscriptionId: 3, propertyName: 'lastname', occurredAt: 9 });
    expect(dedupeKey(a)).toBe('42:3:100:lastname:9');
    expect(dedupeKey({ ...a, attemptNumber: 1 } as typeof a)).toBe(dedupeKey(a));
    expect(dedupeKey({ ...a, objectId: 101 })).not.toBe(dedupeKey(a));
  });
});

describe('processInboxEvent (Flow A)', () => {
  it('drops our own writes (echo rule) without calling HubSpot', async () => {
    const { db, rpc } = fakeDb();
    const request = vi.fn() as unknown as RequestFn;
    const r = await processInboxEvent(event({ changeSource: 'INTEGRATION', sourceId: APP_ID }), deps(db, request));
    expect(r).toMatchObject({ status: 'skipped', outcome: 'own write (echo)' });
    expect(request).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('processes another integration\'s writes', async () => {
    const { db, rpc } = fakeDb({ apply_hubspot_contact: 'updated' });
    const request = vi.fn(async () => contact('100')) as unknown as RequestFn;
    await processInboxEvent(event({ changeSource: 'INTEGRATION', sourceId: '999' }), deps(db, request));
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_contact', expect.objectContaining({ p_contact_id: 100 }));
  });

  it('applies fetched state, not the event value (legacy format too)', async () => {
    const { db, rpc } = fakeDb({ apply_hubspot_contact: 'updated' });
    const request = vi.fn(async () => contact('100', { lastname: 'Fresh' })) as unknown as RequestFn;
    const r = await processInboxEvent(
      event({ subscriptionType: 'contact.propertyChange', objectTypeId: undefined, propertyName: 'lastname' }),
      deps(db, request));
    expect(r).toMatchObject({ status: 'done', outcome: 'updated' });
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_contact', expect.objectContaining({
      p_last_name: 'Fresh', p_modified: '2026-10-07T10:00:00Z' }));
  });

  it('refuses to apply a contact without HubSpot\'s modification time (no server-clock fallback)', async () => {
    const { db, rpc } = fakeDb({ apply_hubspot_contact: 'updated' });
    const request = vi.fn(async () => contact('100', { lastmodifieddate: null })) as unknown as RequestFn;
    await expect(processInboxEvent(event({}), deps(db, request))).rejects.toThrow('has no lastmodifieddate');
    expect(rpc).not.toHaveBeenCalledWith('apply_hubspot_contact', expect.anything());
  });

  it('never stores non-demo contacts: clears one already known, ignores a new one', async () => {
    const known = fakeDb({ apply_hubspot_delete: 'deleted' });
    const request = vi.fn(async () => contact('100', { email: 'someone@realcompany.test' })) as unknown as RequestFn;
    const r = await processInboxEvent(event({}), deps(known.db, request));
    expect(r.outcome).toBe('cleared (not demo data)');
    expect(known.rpc).not.toHaveBeenCalledWith('apply_hubspot_contact', expect.anything());
    const unknown = fakeDb({ apply_hubspot_delete: 'unknown' });
    expect((await processInboxEvent(event({}), deps(unknown.db, request))).outcome).toBe('ignored (not demo data)');
  });

  it('treats a 404 on fetch as a delete', async () => {
    const { db, rpc } = fakeDb({ apply_hubspot_delete: 'deleted' });
    const request = vi.fn(async () => { throw new HubSpotError(404, 'not found', true); }) as unknown as RequestFn;
    const r = await processInboxEvent(event({ subscriptionType: 'object.creation' }), deps(db, request));
    expect(r.outcome).toBe('deleted');
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_delete', { p_contact_id: 100 });
  });

  it('re-points the customer when HubSpot answers with a merged survivor', async () => {
    const { db, rpc } = fakeDb({ apply_hubspot_merge: 'repointed', apply_hubspot_contact: 'updated' });
    const request = vi.fn(async () => contact('200')) as unknown as RequestFn;
    await processInboxEvent(event({}), deps(db, request));
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_merge', { p_old_id: 100, p_new_id: 200 });
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_contact', expect.objectContaining({ p_contact_id: 200 }));
  });

  it('handles deletion and merge events', async () => {
    const { db, rpc } = fakeDb({ apply_hubspot_delete: 'deleted', apply_hubspot_merge: 'merged', apply_hubspot_contact: 'updated' });
    const request = vi.fn(async () => contact('300')) as unknown as RequestFn;
    await processInboxEvent(event({ subscriptionType: 'contact.deletion' }), deps(db, request));
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_delete', { p_contact_id: 100 });
    await processInboxEvent(event({ subscriptionType: 'contact.merge', primaryObjectId: 300, mergedObjectIds: [100] }),
      deps(db, request));
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_merge', { p_old_id: 100, p_new_id: 300 });
  });

  it('folds primary and merged IDs into a newly created merge record', async () => {
    const { db, rpc } = fakeDb({ apply_hubspot_merge: 'repointed', apply_hubspot_contact: 'updated' });
    const request = vi.fn(async () => contact('400')) as unknown as RequestFn;
    await processInboxEvent(event({ subscriptionType: 'contact.merge', objectId: 300, primaryObjectId: 300,
      mergedObjectIds: [100], newObjectId: 400 }), deps(db, request));
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_merge', { p_old_id: 100, p_new_id: 400 });
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_merge', { p_old_id: 300, p_new_id: 400 });
    expect(request).toHaveBeenCalledWith('GET', expect.stringContaining('/contacts/400?'));
  });

  it('skips non-contact events', async () => {
    const { db } = fakeDb();
    const r = await processInboxEvent(event({ objectTypeId: '0-3' }), deps(db, vi.fn() as unknown as RequestFn));
    expect(r.status).toBe('skipped');
  });
});

describe('processOutboxJob (Flow B)', () => {
  const job = (kind: 'rollup' | 'link_contact') => ({ id: 1, kind, customer_id: 'c1', attempts: 1 });
  const rollup = (r: Record<string, unknown>) => [{ hubspot_contact_id: 55, is_deleted: false, total_orders: 3,
    lifetime_value_cents: 12345, last_order_date: '2026-10-02', ...r }];

  it('patches the three demo properties', async () => {
    const { db } = fakeDb({ compute_rollup: rollup({}) });
    const request = vi.fn(async () => ({})) as unknown as RequestFn;
    const r = await processOutboxJob(job('rollup'), deps(db, request));
    expect(r.status).toBe('done');
    expect(request).toHaveBeenCalledWith('PATCH', '/crm/v3/objects/contacts/55', { properties: {
      demo_total_orders: '3', demo_lifetime_value: '123.45', demo_last_order_date: '2026-10-02' } });
  });

  it('requeues a rollup for an unlinked customer', async () => {
    const { db, rpc } = fakeDb({ compute_rollup: rollup({ hubspot_contact_id: null }), requeue_outbox: 'pending' });
    const r = await processOutboxJob(job('rollup'), deps(db, vi.fn() as unknown as RequestFn));
    expect(r.status).toBe('requeued');
    expect(rpc).toHaveBeenCalledWith('requeue_outbox', { p_id: 1, p_delay_seconds: 60 });
  });

  it('parks a rollup that has waited over 30 minutes for a link', async () => {
    const { db } = fakeDb({ compute_rollup: rollup({ hubspot_contact_id: null }), requeue_outbox: 'pending' });
    const old = { ...job('rollup'), created_at: new Date(Date.now() - 31 * 60_000).toISOString() };
    await expect(processOutboxJob(old, deps(db, vi.fn() as unknown as RequestFn)))
      .rejects.toMatchObject({ permanent: true, message: expect.stringContaining('not linked') });
  });

  it('refuses to link a customer outside the demo domain', async () => {
    const customer = { id: 'c1', hubspot_contact_id: null, email: 'a@realcompany.test', first_name: 'A', last_name: 'B', deleted_at: null };
    const { db } = fakeDb({}, customer);
    await expect(processOutboxJob(job('link_contact'), deps(db, vi.fn() as unknown as RequestFn)))
      .rejects.toMatchObject({ permanent: true });
  });

  it('skips deleted customers and contacts missing in HubSpot', async () => {
    const deleted = fakeDb({ compute_rollup: rollup({ is_deleted: true }) });
    expect((await processOutboxJob(job('rollup'), deps(deleted.db, vi.fn() as unknown as RequestFn))).status).toBe('skipped');
    const gone = fakeDb({ compute_rollup: rollup({}) });
    const request = vi.fn(async () => { throw new HubSpotError(404, 'not found', true); }) as unknown as RequestFn;
    expect((await processOutboxJob(job('rollup'), deps(gone.db, request))).status).toBe('skipped');
  });

  it('links an app-made customer to an existing contact without overwriting it', async () => {
    const customer = { id: 'c1', hubspot_contact_id: null, email: 'a@example.com', first_name: 'A', last_name: 'B', deleted_at: null };
    const { db, rpc } = fakeDb({ link_customer: null, apply_hubspot_contact: 'updated' }, customer);
    const request = vi.fn(async () => contact('77')) as unknown as RequestFn;
    const r = await processOutboxJob(job('link_contact'), deps(db, request));
    expect(r.outcome).toBe('linked existing contact');
    expect(rpc).toHaveBeenCalledWith('link_customer', { p_customer: 'c1', p_contact_id: 77 });
    expect(vi.mocked(request).mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });
});

describe('drain', () => {
  it('finishes successes, fails errors as permanent or transient, and stops when empty', async () => {
    let claims = 0;
    const { db, rpc } = fakeDb({
      claim_outbox: () => (claims++ === 0 ? [{ id: 1, kind: 'rollup', customer_id: 'a' }, { id: 2, kind: 'rollup', customer_id: 'b' }] : []),
      compute_rollup: [{ hubspot_contact_id: 5, is_deleted: false, total_orders: 1, lifetime_value_cents: 100, last_order_date: null }],
      fail_job: 'dead',
    });
    const request = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new HubSpotError(400, 'bad', true)) as unknown as RequestFn;
    const stats = await drainOutbox(deps(db, request), Date.now() + 10_000);
    expect(stats).toMatchObject({ done: 1, dead: 1 });
    expect(rpc).toHaveBeenCalledWith('finish_job', { p_queue: 'outbox', p_id: 1, p_status: 'done' });
    expect(rpc).toHaveBeenCalledWith('fail_job', expect.objectContaining({ p_id: 2, p_permanent: true }));
  });

  it('releases claimed rows it has no time left to start', async () => {
    let claims = 0;
    const { db, rpc } = fakeDb({
      claim_outbox: () => (claims++ === 0 ? [{ id: 1, kind: 'rollup', customer_id: 'a' }, { id: 2, kind: 'rollup', customer_id: 'b' }] : []),
      compute_rollup: [{ hubspot_contact_id: 5, is_deleted: false, total_orders: 1, lifetime_value_cents: 100, last_order_date: null }],
    });
    const deadline = Date.now() + 1_000;
    // The first row takes past the deadline; the second must be handed back, not processed.
    const request = vi.fn(async () => { vi.setSystemTime(deadline + 1); return {}; }) as unknown as RequestFn;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const stats = await drainOutbox(deps(db, request), deadline);
      expect(stats.done).toBe(1);
      expect(rpc).toHaveBeenCalledWith('release_jobs', { p_queue: 'outbox', p_ids: [2] });
    } finally {
      vi.useRealTimers();
    }
  });
});
