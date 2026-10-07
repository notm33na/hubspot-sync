// Test doubles shared by the unit tests.
import { vi } from 'vitest';
import type { CustomerRow, SyncDb } from '../db';
import type { RequestFn } from '../hubspot';
import type { SyncDeps } from '../sync/inbound';

export const APP_ID = '1234567';

/** rpcResults: value, or function returning the value, per RPC name. */
export function fakeDb(rpcResults: Record<string, unknown> = {}, customer: CustomerRow | null = null, linkedIds: number[] = []) {
  const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
    const r = rpcResults[fn];
    return typeof r === 'function' ? (r as (a?: Record<string, unknown>) => unknown)(args) : r;
  });
  const db: SyncDb = {
    rpc: rpc as SyncDb['rpc'],
    getCustomer: vi.fn(async () => customer),
    insertInboxEvents: vi.fn(async () => 0),
    log: vi.fn(async () => {}),
    updateFormSubmission: vi.fn(async () => {}),
    recentLog: vi.fn(async () => []),
    linkedContactIds: vi.fn(async (after: number, limit: number) => linkedIds.filter((id) => id > after).slice(0, limit)),
  };
  return { db, rpc };
}

export function deps(db: SyncDb, request: RequestFn): SyncDeps {
  return { db, request, appId: APP_ID };
}

export const contact = (id: string, props: Record<string, string | null> = {}) => ({
  id,
  properties: {
    email: 'x@example.com', firstname: 'X', lastname: 'Y', phone: null, lifecyclestage: 'lead',
    lastmodifieddate: '2026-10-07T10:00:00Z', ...props,
  },
});
