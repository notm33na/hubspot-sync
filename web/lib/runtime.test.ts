// Workers runtime context: background work, subrequest counting, and the drain stopping before the
// Workers Free limit of 50 subrequests per invocation.
import { describe, expect, it, vi } from 'vitest';
import type { RequestFn } from './hubspot';
import { countSubrequest, countingFetch, runInvocation, SUBREQUEST_LIMIT, subrequestsLeft, waitUntil } from './runtime';
import { drainOutbox } from './sync/drain';
import { deps, fakeDb } from './testing/fakes';

const ctx = () => ({ waitUntil: vi.fn() });

describe('runtime context', () => {
  it('passes background work to the invocation and is a no-op outside one', () => {
    const c = ctx();
    const p = Promise.resolve();
    runInvocation(c, () => waitUntil(p));
    expect(c.waitUntil).toHaveBeenCalledWith(p);
    expect(() => waitUntil(Promise.resolve())).not.toThrow();
  });

  it('counts fetches per invocation, separately for concurrent invocations', async () => {
    const f = countingFetch(vi.fn(async () => new Response('ok')) as unknown as typeof fetch);
    const a = runInvocation(ctx(), async () => { await f('https://a'); await f('https://a'); return subrequestsLeft(); });
    const b = runInvocation(ctx(), async () => { await f('https://b'); return subrequestsLeft(); });
    expect(await a).toBe(SUBREQUEST_LIMIT - 2);
    expect(await b).toBe(SUBREQUEST_LIMIT - 1);
    expect(subrequestsLeft()).toBe(Infinity);
  });
});

describe('drain within the subrequest budget', () => {
  it('releases the rows it cannot afford instead of exceeding the limit', async () => {
    let claims = 0;
    const rows = [1, 2, 3, 4, 5].map((id) => ({ id, kind: 'rollup', customer_id: `c${id}` }));
    const { db, rpc } = fakeDb({
      claim_outbox: () => (claims++ === 0 ? rows : []),
      compute_rollup: [{ hubspot_contact_id: 5, is_deleted: false, total_orders: 1, lifetime_value_cents: 100, last_order_date: null }],
    });
    // Each row costs 12 subrequests here: 50 → 38 → 26 → 14, and 14 is below the 16 a row needs to start.
    const request = vi.fn(async () => { for (let i = 0; i < 12; i++) countSubrequest(); return {}; }) as unknown as RequestFn;
    const stats = await runInvocation(ctx(), () => drainOutbox(deps(db, request), Date.now() + 60_000));
    expect(stats.done).toBe(3);
    expect(rpc).toHaveBeenCalledWith('release_jobs', { p_queue: 'outbox', p_ids: [4, 5] });
  });
});
