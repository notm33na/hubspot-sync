// Route-level auth checks: every rejection happens before any database or HubSpot access.
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: () => { throw new Error('database must not be reached'); } }));
vi.mock('@/lib/sync/deps', () => ({ syncDeps: () => { throw new Error('sync deps must not be reached'); } }));

beforeAll(() => {
  Object.assign(process.env, {
    HUBSPOT_CLIENT_SECRET: 'test-client-secret',
    HUBSPOT_PORTAL_ID: '123',
    DRAIN_SECRET: 'test-drain-secret',
    CRON_SECRET: 'test-cron-secret',
  });
});

describe('route authentication', () => {
  it('webhook rejects an unsigned request', async () => {
    const { POST } = await import('./hubspot/webhook/route');
    const res = await POST(new Request('https://demo.test/api/hubspot/webhook', { method: 'POST', body: '[]' }));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized');
  });

  it('card rejects an unsigned request', async () => {
    const { GET } = await import('./card/orders/route');
    const res = await GET(new Request('https://demo.test/api/card/orders?contactId=1&portalId=123'));
    expect(res.status).toBe(401);
  });

  it('drain rejects a missing or wrong bearer', async () => {
    const { POST } = await import('./drain/route');
    expect((await POST(new Request('https://demo.test/api/drain', { method: 'POST' }))).status).toBe(401);
    const wrong = new Request('https://demo.test/api/drain', { method: 'POST', headers: { authorization: 'Bearer nope' } });
    expect((await POST(wrong)).status).toBe(401);
  });

  it('daily cron rejects a missing or wrong bearer', async () => {
    const { GET } = await import('./cron/daily/route');
    expect((await GET(new Request('https://demo.test/api/cron/daily'))).status).toBe(401);
    const wrong = new Request('https://demo.test/api/cron/daily', { headers: { authorization: 'Bearer test-drain-secret' } });
    expect((await GET(wrong)).status).toBe(401);
  });
});
