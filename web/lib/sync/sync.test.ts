import { describe, expect, it, vi } from 'vitest';
import type { CustomerRow, HubSpotEvent, SyncDb } from '../db';
import { HubSpotError, type RequestFn } from '../hubspot';
import { dedupeKey, processInboxEvent, type SyncDeps } from './inbound';
import { processOutboxJob } from './outbound';
import { drainOutbox } from './drain';

const APP_ID = '56058178';

function fakeDb(rpcResults: Record<string, unknown> = {}, customer: CustomerRow | null = null) {
  const rpc = vi.fn(async (fn: string) => {
    const r = rpcResults[fn];
    return typeof r === 'function' ? (r as () => unknown)() : r;
  });
  const db: SyncDb = {
    rpc: rpc as SyncDb['rpc'],
    getCustomer: vi.fn(async () => customer),
    insertInboxEvents: vi.fn(async () => 0),
    log: vi.fn(async () => {}),
  };
  return { db, rpc };
}

function deps(db: SyncDb, request: RequestFn): SyncDeps {
  return { db, request, appId: APP_ID };
}

const contact = (id: string, props: Record<string, string> = {}) => ({
  id,
  properties: { email: 'x@example.com', firstname: 'X', lastname: 'Y', phone: null, lifecyclestage: 'lead',
    hs_lastmodifieddate: '2026-10-07T10:00:00Z', ...props },
});

const event = (e: Partial<HubSpotEvent>): HubSpotEvent => ({
  subscriptionType: 'object.propertyChange', objectTypeId: '0-1', objectId: 100,
  changeSource: 'CRM_UI', sourceId: 'userId:1', eventId: 1, ...e,
});

describe('dedupeKey', () => {
  it('prefers eventId, falls back to a composite key', () => {
    expect(dedupeKey(event({ eventId: 42 }))).toBe('e:42');
    expect(dedupeKey(event({ eventId: undefined, subscriptionId: 3, propertyName: 'lastname', occurredAt: 9 })))
      .toBe('s:3:100:lastname:9');
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
});
