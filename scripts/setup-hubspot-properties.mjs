// Creates the "Demo order data" property group and the three demo_* contact properties if missing.
// Usage: node scripts/setup-hubspot-properties.mjs   (reads HUBSPOT_TOKEN from .env.local; never prints it)
import { readEnvFile } from './lib/env-file.mjs';

const env = { ...readEnvFile(new URL('../.env.local', import.meta.url)), ...process.env };
const token = env.HUBSPOT_TOKEN;
if (!token) {
  console.error('HUBSPOT_TOKEN missing from .env.local');
  process.exit(1);
}

const GROUP = 'demo_order_data';
const PROPERTIES = [
  { name: 'demo_total_orders', label: 'Demo: total orders', type: 'number', fieldType: 'number',
    description: 'Fictional Fernhill demo. Count of non-cancelled orders in Supabase. Read-only: set by the sync.' },
  { name: 'demo_lifetime_value', label: 'Demo: lifetime value', type: 'number', fieldType: 'number',
    description: 'Fictional Fernhill demo. Sum of non-cancelled order totals. Read-only: set by the sync.' },
  { name: 'demo_last_order_date', label: 'Demo: last order date', type: 'date', fieldType: 'date',
    description: 'Fictional Fernhill demo. Date of the latest order. Read-only: set by the sync.' },
];

async function hubspot(method, path, body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const group = await hubspot('POST', '/crm/v3/properties/contacts/groups', { name: GROUP, label: 'Demo order data' });
console.log(`group ${GROUP}: ${group.status === 201 ? 'created' : group.status === 409 ? 'exists' : `HTTP ${group.status} ${group.json.message ?? ''}`}`);

let failed = false;
for (const p of PROPERTIES) {
  const r = await hubspot('POST', '/crm/v3/properties/contacts', { ...p, groupName: GROUP });
  const outcome = r.status === 201 ? 'created' : r.status === 409 ? 'exists' : `HTTP ${r.status} ${r.json.message ?? ''}`;
  if (r.status !== 201 && r.status !== 409) failed = true;
  console.log(`property ${p.name}: ${outcome}`);
}
process.exit(failed ? 1 : 0);
