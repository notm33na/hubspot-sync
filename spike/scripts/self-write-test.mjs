// Spike: do our own API writes trigger webhooks, and with what changeSource?
// Usage (from spike/):  node --env-file=.env.local scripts/self-write-test.mjs
// .env.local must contain HUBSPOT_TOKEN=<static app access token>. The token is never printed.

const token = process.env.HUBSPOT_TOKEN;
if (!token) {
  console.error('HUBSPOT_TOKEN missing (put it in spike/.env.local)');
  process.exit(1);
}

const API = 'https://api.hubapi.com/crm/v3/objects/contacts';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function call(method, url, body) {
  const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url.replace(API, '')} -> ${res.status} ${json.message ?? ''}`);
  return json;
}

const stamp = Date.now();
const created = await call('POST', API, {
  properties: {
    email: `spike-${stamp}@example.com`,
    firstname: 'Spike',
    lastname: `Created-${stamp}`,
  },
});
console.log(`created contact ${created.id} at ${new Date().toISOString()}`);

await new Promise((r) => setTimeout(r, 5000));

await call('PATCH', `${API}/${created.id}`, {
  properties: { firstname: `ApiEdit-${stamp}`, lastname: `ApiEdit-${stamp}` },
});
console.log(`patched firstname+lastname on ${created.id} at ${new Date().toISOString()}`);
console.log('Now check Vercel logs for WEBHOOK_EVENT lines with this objectId.');
