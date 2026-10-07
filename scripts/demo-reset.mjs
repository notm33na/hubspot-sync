// Demo reset (R12, ARCHITECTURE §7 "Reset"): restore a known synthetic state.
//   1. HubSpot: archive deals named "Fernhill demo:…" and contacts with @example.com emails ONLY
//      (each candidate re-checked in code, not just by the search filter).
//   2. HubSpot: create the seed contacts.
//   3. Supabase: delete all demo data (sync triggers paused), then seed pre-linked customers and orders.
// Usage: node scripts/demo-reset.mjs --yes      (reads .env.local; never prints secrets)
import { readEnvFile } from './lib/env-file.mjs';

if (!process.argv.includes('--yes')) {
  console.log('This deletes all demo data in Supabase and archives @example.com contacts and "Fernhill demo" deals in HubSpot.');
  console.log('Run again with --yes to proceed.');
  process.exit(1);
}

const env = readEnvFile(new URL('../.env.local', import.meta.url));
for (const name of ['HUBSPOT_TOKEN', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_URL']) {
  if (!env[name]) throw new Error(`${name} missing from .env.local`);
}
const ref = env.SUPABASE_DB_URL.match(/\/\/postgres\.([a-z0-9]+):/)?.[1];
const supabaseUrl = env.SUPABASE_URL ?? `https://${ref}.supabase.co`;

async function hubspot(method, path, body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 207) throw new Error(`HubSpot ${method} ${path}: HTTP ${res.status} ${json.message ?? ''}`);
  return json;
}

async function rpc(fn, args = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Supabase rpc ${fn}: HTTP ${res.status} ${json.message ?? ''}`);
  return json;
}

// Search narrows the candidates; `keep` re-checks each one in code before anything is archived.
async function searchIds(objectType, filter, property, keep) {
  const ids = [];
  let after;
  do {
    const page = await hubspot('POST', `/crm/v3/objects/${objectType}/search`, {
      filterGroups: [{ filters: [filter] }], properties: [property], limit: 100, ...(after ? { after } : {}),
    });
    ids.push(...page.results.filter((r) => keep(r.properties[property] ?? '')).map((r) => r.id));
    after = page.paging?.next?.after;
  } while (after);
  return ids;
}

async function archive(objectType, ids) {
  for (let i = 0; i < ids.length; i += 100) {
    await hubspot('POST', `/crm/v3/objects/${objectType}/batch/archive`, { inputs: ids.slice(i, i + 100).map((id) => ({ id })) });
  }
}

// Order (ARCHITECTURE §7): HubSpot cleanup and seed creation first; Supabase is only touched once
// HubSpot has succeeded, so a failure cannot leave the database empty.

// ------------------------------------------------------------- 1. HubSpot cleanup
const dealIds = await searchIds('deals', { propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: 'Fernhill' },
  'dealname', (name) => name.startsWith('Fernhill demo:'));
await archive('deals', dealIds);
const contactIds = await searchIds('contacts', { propertyName: 'email', operator: 'CONTAINS_TOKEN', value: '*@example.com' },
  'email', (email) => email.toLowerCase().endsWith('@example.com'));
await archive('contacts', contactIds);
console.log(`hubspot: archived ${dealIds.length} demo deals, ${contactIds.length} @example.com contacts`);

// ------------------------------------------------------------- 2. HubSpot seed contacts
// Deterministic synthetic data (fictional people, @example.com only).
const PEOPLE = [
  ['Avery', 'Lindqvist', 'customer'], ['Jordan', 'Okafor', 'customer'], ['Priya', 'Raman', 'customer'],
  ['Mateo', 'Ferreira', 'opportunity'], ['Hana', 'Kobayashi', 'lead'], ['Samir', 'Haddad', 'customer'],
];
const STATUSES = ['delivered', 'delivered', 'shipped', 'processing', 'cancelled'];
let seed = 20261007;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const created = await hubspot('POST', '/crm/v3/objects/contacts/batch/create', {
  inputs: PEOPLE.map(([first, last, stage]) => ({
    properties: { email: `${first}.${last}@example.com`.toLowerCase(), firstname: first, lastname: last, lifecyclestage: stage },
  })),
});
const byEmail = new Map(created.results.map((r) => [r.properties.email, r]));

let orderNo = 1000;
const customers = PEOPLE.map(([first, last, stage], i) => {
  const email = `${first}.${last}@example.com`.toLowerCase();
  const contact = byEmail.get(email);
  if (!contact) throw new Error(`seed contact not created: #${i + 1}`);
  const count = i === 4 ? 0 : 1 + Math.floor(rand() * 5); // one contact with no orders, for the empty state
  const orders = Array.from({ length: count }, () => {
    const daysAgo = Math.floor(rand() * 120);
    return {
      order_number: `FH-${++orderNo}`,
      ordered_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      total_cents: 1500 + Math.floor(rand() * 60000),
      status: daysAgo < 5 ? 'processing' : STATUSES[Math.floor(rand() * STATUSES.length)],
    };
  });
  return {
    hubspot_contact_id: Number(contact.id), email, first_name: first, last_name: last,
    lifecycle_stage: stage, hs_last_modified: contact.updatedAt, orders,
  };
});

// ------------------------------------------------------------- 3. Supabase
const cleared = await rpc('demo_reset_supabase');
console.log(`supabase: cleared ${cleared.customers} customers, ${cleared.orders} orders`);
const seeded = await rpc('demo_seed', { p_customers: customers });
console.log(`seeded: ${seeded.customers} customers with ${seeded.orders} orders (roll-ups now syncing to HubSpot)`);
