// Server-side database access through the Supabase secret key (bypasses RLS; never sent to a browser).
import { createClient } from '@supabase/supabase-js';
import { env } from './env';

export interface CustomerRow {
  id: string;
  hubspot_contact_id: number | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  deleted_at: string | null;
}

export interface InboxRow {
  id: number;
  payload: HubSpotEvent;
  attempts: number;
}

export interface OutboxRow {
  id: number;
  kind: 'rollup' | 'link_contact';
  customer_id: string;
  attempts: number;
}

export interface HubSpotEvent {
  eventId?: number;
  subscriptionId?: number;
  subscriptionType: string;
  objectId: number;
  objectTypeId?: string;
  propertyName?: string;
  changeSource?: string;
  sourceId?: string;
  occurredAt?: number;
  primaryObjectId?: number;
  mergedObjectIds?: number[];
  newObjectId?: number;
}

export interface SyncLogEntry {
  direction: 'inbound' | 'outbound' | 'form' | 'system';
  object_id: string | null;
  action: string;
  outcome: string;
}

/** The operations the sync code needs; a fake implements this in tests. */
export interface SyncDb {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
  getCustomer(id: string): Promise<CustomerRow | null>;
  insertInboxEvents(rows: { dedupe_key: string; payload: HubSpotEvent }[]): Promise<number>;
  log(entry: SyncLogEntry): Promise<void>;
}

/** Postgres integrity/data errors cannot succeed on retry. */
export class DbError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'DbError';
  }
  get permanent(): boolean {
    return !!this.code && (this.code.startsWith('22') || this.code.startsWith('23'));
  }
}

let cached: SyncDb | undefined;

export function db(): SyncDb {
  if (cached) return cached;
  const client = createClient(env('SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const fail = (what: string, e: { message: string; code?: string }) => {
    throw new DbError(`${what}: ${e.message}`, e.code);
  };

  cached = {
    async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      const { data, error } = await client.rpc(fn, args);
      if (error) fail(`rpc ${fn}`, error);
      return data as T;
    },
    async getCustomer(id) {
      const { data, error } = await client
        .from('customers')
        .select('id, hubspot_contact_id, email, first_name, last_name, deleted_at')
        .eq('id', id)
        .maybeSingle();
      if (error) fail('get customer', error);
      return data as CustomerRow | null;
    },
    async insertInboxEvents(rows) {
      if (rows.length === 0) return 0;
      const { data, error } = await client
        .from('sync_inbox')
        .upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true })
        .select('id');
      if (error) fail('insert inbox', error);
      return data?.length ?? 0;
    },
    async log(entry) {
      // Best effort: a failed log line must never fail the sync itself.
      const { error } = await client.from('sync_log').insert(entry);
      if (error) console.log(JSON.stringify({ event: 'sync_log_failed', message: error.message }));
    },
  };
  return cached;
}
