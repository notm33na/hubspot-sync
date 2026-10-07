import { describe, expect, it, vi } from 'vitest';
import { HubSpotError, type RequestFn } from '../hubspot';
import { contact, deps, fakeDb } from '../testing/fakes';
import { runDaily } from './daily';

describe('runDaily', () => {
  it('applies recent contacts across pages, resolves missing linked contacts, prunes', async () => {
    const { db, rpc } = fakeDb(
      { claim_outbox: [], claim_inbox: [], apply_hubspot_contact: 'updated', apply_hubspot_delete: 'deleted', prune_old_rows: { sync_log: 0 } },
      null,
      [11, 12, 13],
    );
    const request = vi.fn(async (method: string, path: string, body?: { after?: string }) => {
      if (path.endsWith('/search')) {
        return body?.after
          ? { results: [contact('12')] }
          : { results: [contact('11')], paging: { next: { after: 'p2' } } };
      }
      if (path.endsWith('/batch/read')) return { results: [{ id: '11' }, { id: '12' }] }; // 13 is gone
      if (method === 'GET' && path.includes('/contacts/13?')) throw new HubSpotError(404, 'not found', true);
      throw new Error(`unexpected ${method} ${path}`);
    }) as unknown as RequestFn;

    const stats = await runDaily(deps(db, request), Date.now() + 60_000, Date.parse('2026-10-07T12:00:00Z'));

    expect(stats).toMatchObject({ recentContacts: 2, checkedLinked: 3, missingResolved: { deleted: 1 }, timedOut: false });
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_delete', { p_contact_id: 13 });
    expect(rpc).toHaveBeenCalledWith('prune_old_rows');
    const searchBody = vi.mocked(request).mock.calls.find(([, p]) => p.endsWith('/search'))?.[2] as {
      filterGroups: { filters: { value: string }[] }[];
    };
    expect(searchBody.filterGroups[0].filters[0].value).toBe(String(Date.parse('2026-10-05T12:00:00Z')));
  });

  it('isolates a failing contact, keeps going, and filters non-demo contacts', async () => {
    let calls = 0;
    const { db, rpc } = fakeDb({
      claim_outbox: [], claim_inbox: [], prune_old_rows: {}, apply_hubspot_delete: 'unknown',
      apply_hubspot_contact: () => {
        if (calls++ === 0) throw Object.assign(new Error('duplicate key value violates unique constraint'), { permanent: true });
        return 'updated';
      },
    });
    const request = vi.fn(async (_m: string, path: string) => path.endsWith('/search')
      ? { results: [contact('1'), contact('2'), contact('3', { email: 'boss@realcompany.test' })] }
      : { results: [] }) as unknown as RequestFn;
    const stats = await runDaily(deps(db, request), Date.now() + 60_000);
    expect(stats).toMatchObject({ recentContacts: 3, errors: 1, recentApplied: { updated: 1, 'ignored (not demo data)': 1 } });
    // Cleared with HubSpot's modification time, not the server clock.
    expect(rpc).toHaveBeenCalledWith('apply_hubspot_delete', { p_contact_id: 3, p_deleted_at: '2026-10-07T10:00:00Z' });
  });

  it('prunes even when out of time', async () => {
    const { db, rpc } = fakeDb({ claim_outbox: [], claim_inbox: [], prune_old_rows: {} });
    const stats = await runDaily(deps(db, vi.fn() as unknown as RequestFn), Date.now() - 1);
    expect(stats.timedOut).toBe(true);
    expect(rpc).toHaveBeenCalledWith('prune_old_rows');
  });
});
