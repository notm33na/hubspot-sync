import { db } from '../db';
import { env } from '../env';
import { createHubSpotClient } from '../hubspot';
import type { SyncDeps } from './inbound';

export function syncDeps(): SyncDeps {
  return {
    db: db(),
    request: createHubSpotClient({ token: env('HUBSPOT_TOKEN') }),
    appId: env('HUBSPOT_APP_ID'),
  };
}
