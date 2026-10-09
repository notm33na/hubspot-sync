// Webhook ingest: a correctly signed delivery whose events are already in the inbox is logged as ignored duplicates.
import crypto from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '@/lib/testing/fakes';

const SECRET = 'test-client-secret';
const WEBHOOK_URL = 'https://demo.test/api/hubspot/webhook';
const pending: Promise<unknown>[] = [];
let store = fakeDb();

vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => pending.push(p) }));
vi.mock('@/lib/sync/deps', () => ({ syncDeps: () => ({ db: store.db, request: vi.fn(), appId: '1' }) }));
vi.mock('@/lib/sync/drain', () => ({ drainInbox: vi.fn(async () => ({ done: 0, skipped: 0, requeued: 0, failed: 0, dead: 0 })) }));

beforeAll(() => {
  process.env.HUBSPOT_CLIENT_SECRET = SECRET;
});

beforeEach(() => {
  store = fakeDb();
  pending.length = 0;
});

function signed(events: unknown[]): Request {
  const body = JSON.stringify(events);
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', SECRET).update(`POST${WEBHOOK_URL}${body}${ts}`, 'utf8').digest('base64');
  return new Request(WEBHOOK_URL, {
    method: 'POST',
    body,
    headers: { 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': ts },
  });
}

const ev = (objectId: number, eventId: number) => ({
  eventId, subscriptionId: 9, subscriptionType: 'contact.propertyChange', objectId, propertyName: 'phone', occurredAt: 1,
});

describe('webhook ingest', () => {
  it('logs already-received events as ignored duplicates', async () => {
    vi.mocked(store.db.insertInboxEvents).mockResolvedValueOnce(0);
    const { POST } = await import('./route');
    expect((await POST(signed([ev(42, 1)]))).status).toBe(204);
    await Promise.all(pending);
    expect(store.db.log).toHaveBeenCalledWith({ direction: 'inbound', object_id: '42', action: 'webhook', outcome: '1 duplicate ignored' });
  });

  it('counts duplicates in a mixed batch, without an object ID when several contacts are involved', async () => {
    vi.mocked(store.db.insertInboxEvents).mockResolvedValueOnce(1);
    const { POST } = await import('./route');
    expect((await POST(signed([ev(42, 1), ev(43, 2), ev(44, 3)]))).status).toBe(204);
    await Promise.all(pending);
    expect(store.db.log).toHaveBeenCalledWith({ direction: 'inbound', object_id: null, action: 'webhook', outcome: '2 duplicates ignored' });
  });

  it('logs nothing extra when every event is new', async () => {
    vi.mocked(store.db.insertInboxEvents).mockResolvedValueOnce(1);
    const { POST } = await import('./route');
    expect((await POST(signed([ev(42, 1)]))).status).toBe(204);
    await Promise.all(pending);
    expect(store.db.log).not.toHaveBeenCalled();
  });
});
