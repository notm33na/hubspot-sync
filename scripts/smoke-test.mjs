// Loop-safety smoke test against the LIVE deployment (docs/SMOKE-TEST.md). Synthetic data only; never prints secrets.
//   1. HubSpot -> DB: waits for YOU to edit the contact in the HubSpot UI (an API write with the app's token would be
//      dropped by the echo rule, so it would not test this path), then checks one processed event and no outbound write.
//   2. DB -> HubSpot: inserts one order, checks exactly one roll-up PATCH, one history entry per property, no echo
//      processed. Cleanup cancels the order (cancelled orders are excluded), which restores the totals; customers and
//      orders are never hard-deleted outside the demo reset.
//   3. Idempotency: replays an already-processed webhook, re-signed (v3) with a fresh timestamp -> must be de-duplicated;
//      the same request with a 10-minute-old timestamp -> must get 401.
// Usage: node scripts/smoke-test.mjs --yes [--email avery.lindqvist@example.com] [--skip-ui] [--ui-timeout 300]
// Then run `node scripts/demo-reset.mjs --yes` to remove the cancelled smoke order.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readEnvFile } from './lib/env-file.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
if (!args.includes('--yes')) {
  console.log('Runs against the live deployment: adds (then cancels) one synthetic order and replays one webhook.');
  console.log('Run again with --yes to proceed.');
  process.exit(1);
}
const EMAIL = opt('--email', 'avery.lindqvist@example.com');
const UI_TIMEOUT_S = Number(opt('--ui-timeout', '300'));
if (!EMAIL.toLowerCase().endsWith('@example.com')) throw new Error('demo contacts only (@example.com)');

const env = readEnvFile(new URL('../.env.local', import.meta.url));
for (const name of ['HUBSPOT_TOKEN', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_APP_ID', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_URL']) {
  if (!env[name]) throw new Error(`${name} missing from .env.local`);
}
const ref = env.SUPABASE_DB_URL.match(/\/\/postgres\.([a-z0-9]+):/)?.[1];
const supabaseUrl = env.SUPABASE_URL ?? `https://${ref}.supabase.co`;
const webhooks = JSON.parse(fs.readFileSync(new URL('../hubspot/src/app/webhooks/webhooks-hsmeta.json', import.meta.url), 'utf8'));
const WEBHOOK_URL = webhooks.config.settings.targetUrl;
const ROLLUP = ['demo_total_orders', 'demo_lifetime_value', 'demo_last_order_date'];

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

async function sb(path, init = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation', ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${init.method ?? 'GET'} ${path.split('?')[0]}: HTTP ${res.status}`);
  return res.status === 204 ? [] : res.json();
}

async function contact(id) {
  const props = [...ROLLUP, 'lastmodifieddate'].join(',');
  const res = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${id}?properties=${props}&propertiesWithHistory=${ROLLUP.join(',')}`,
    { headers: { Authorization: `Bearer ${env.HUBSPOT_TOKEN}` } });
  if (!res.ok) throw new Error(`HubSpot GET contact: HTTP ${res.status}`);
  const c = await res.json();
  return { props: c.properties, history: Object.fromEntries(ROLLUP.map((p) => [p, c.propertiesWithHistory?.[p]?.length ?? 0])) };
}

const maxId = async (table) => (await sb(`${table}?select=id&order=id.desc&limit=1`))[0]?.id ?? 0;
const marks = async () => ({ inbox: await maxId('sync_inbox'), outbox: await maxId('sync_outbox'), log: await maxId('sync_log') });
const newInbox = (m, contactId) => sb(`sync_inbox?id=gt.${m.inbox}&payload->>objectId=eq.${contactId}&select=id,status,payload&order=id`);
const newOutbox = (m, customerId) => sb(`sync_outbox?id=gt.${m.outbox}&customer_id=eq.${customerId}&select=id,kind,status&order=id`);
const newLog = (m) => sb(`sync_log?id=gt.${m.log}&select=id,at,direction,object_id,action,outcome&order=id`);
const FINAL = new Set(['done', 'skipped', 'dead']);

async function poll(fn, timeoutMs, everyMs = 2000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(everyMs);
  }
}

const results = [];
function check(step, name, ok, detail = '') {
  results.push({ step, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${step}] ${name}${detail ? `  (${detail})` : ''}`);
}

// Same rule as the roll-up: cancelled orders excluded, last order date in UTC.
function expectedRollup(orders) {
  const live = orders.filter((o) => o.status !== 'cancelled');
  const cents = live.reduce((s, o) => s + o.total_cents, 0);
  const last = live.map((o) => o.ordered_at).sort().pop();
  return {
    demo_total_orders: String(live.length),
    demo_lifetime_value: (cents / 100).toFixed(2),
    demo_last_order_date: last ? new Date(last).toISOString().slice(0, 10) : '',
  };
}

function signedPost(body, ageMs = 0) {
  const ts = String(Date.now() - ageMs);
  const sig = crypto.createHmac('sha256', env.HUBSPOT_CLIENT_SECRET).update(`POST${WEBHOOK_URL}${body}${ts}`, 'utf8').digest('base64');
  return fetch(WEBHOOK_URL, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-HubSpot-Signature-v3': sig, 'X-HubSpot-Request-Timestamp': ts },
  });
}

// ------------------------------------------------------------------ setup
const [customer] = await sb(`customers?email=eq.${encodeURIComponent(EMAIL.toLowerCase())}&deleted_at=is.null&select=id,hubspot_contact_id,hs_last_modified`);
if (!customer?.hubspot_contact_id) throw new Error(`no linked, live customer for ${EMAIL}; run demo-reset first`);
const contactId = String(customer.hubspot_contact_id);
console.log(`${now()}  smoke test: contact ${contactId}, customer ${customer.id}, webhook ${WEBHOOK_URL}\n`);
let replayId;

// ------------------------------------------------------------------ 1. HubSpot -> DB
if (!args.includes('--skip-ui')) {
  const m = await marks();
  const before = await contact(contactId);
  console.log(`In HubSpot, open ${EMAIL} and change ONE of: phone, first name, last name, lifecycle stage. Then save.`);
  console.log(`Waiting up to ${UI_TIMEOUT_S} s...`);
  const rows = await poll(async () => {
    const r = await newInbox(m, contactId);
    return r.length && r.every((x) => FINAL.has(x.status)) ? r : null;
  }, UI_TIMEOUT_S * 1000);
  if (!rows) {
    check('1', 'UI edit received', false, 'no webhook arrived in time');
  } else {
    await sleep(5000); // let any trailing event or write land
    const all = await newInbox(m, contactId);
    const human = all.filter((x) => x.payload.changeSource !== 'INTEGRATION');
    console.log(`${now()}  received ${all.length} event(s): ${all.map((x) => `#${x.id} ${x.payload.propertyName ?? x.payload.subscriptionType} ${x.payload.changeSource} -> ${x.status}`).join(', ')}`);
    check('1', 'exactly one non-integration event, processed', human.length === 1 && human[0].status === 'done');
    const [after] = await sb(`customers?id=eq.${customer.id}&select=hs_last_modified`);
    check('1', 'database row updated', after.hs_last_modified !== customer.hs_last_modified,
      `hs_last_modified ${customer.hs_last_modified} -> ${after.hs_last_modified}`);
    const logs = (await newLog(m)).filter((l) => l.object_id === contactId && l.direction === 'inbound');
    check('1', 'activity shows the inbound update', logs.some((l) => l.outcome === 'updated'), logs.map((l) => `${l.at} ${l.outcome}`).join('; '));
    check('1', 'zero outbound jobs', (await newOutbox(m, customer.id)).length === 0);
    const h = (await contact(contactId)).history;
    check('1', 'zero HubSpot roll-up writes', ROLLUP.every((p) => h[p] === before.history[p]));
    replayId = human[0]?.id;
  }
}

// ------------------------------------------------------------------ 2. DB -> HubSpot
{
  const m = await marks();
  const before = await contact(contactId);
  const orderNumber = `FH-SMOKE-${Date.now()}`;
  const [order] = await sb('orders', {
    method: 'POST',
    body: JSON.stringify({ order_number: orderNumber, customer_id: customer.id, ordered_at: now(), total_cents: 12345, status: 'processing' }),
  });
  console.log(`\n${now()}  inserted order ${orderNumber}`);
  const done = await poll(async () => {
    const r = await newOutbox(m, customer.id);
    return r.length && r.every((x) => FINAL.has(x.status)) ? r : null;
  }, 120_000);
  console.log(`${now()}  roll-up finished; waiting 30 s for any echo webhook`);
  await sleep(30_000);

  const jobs = await newOutbox(m, customer.id);
  check('2', 'exactly one outbound roll-up job, done', !!done && jobs.length === 1 && jobs[0].kind === 'rollup' && jobs[0].status === 'done',
    jobs.map((j) => `#${j.id} ${j.kind} ${j.status}`).join(', '));
  const orders = await sb(`orders?customer_id=eq.${customer.id}&select=ordered_at,total_cents,status`);
  const want = expectedRollup(orders);
  const after = await contact(contactId);
  check('2', 'HubSpot count, value and last-order properties correct', ROLLUP.every((p) => (after.props[p] ?? '') === want[p]),
    ROLLUP.map((p) => `${p} ${before.props[p]} -> ${after.props[p]}`).join(', '));
  check('2', 'one history entry per roll-up property', ROLLUP.every((p) => after.history[p] === before.history[p] + 1));
  const echoes = await newInbox(m, contactId);
  check('2', 'no echo processed (any echo skipped)', echoes.every((x) => x.status === 'skipped'), `${echoes.length} webhook(s) for this contact`);
  const logs = (await newLog(m)).filter((l) => l.direction === 'outbound');
  check('2', 'activity shows one outbound roll-up', logs.length === 1 && logs[0].action === 'rollup', logs.map((l) => `${l.at} ${l.object_id} ${l.outcome}`).join('; '));

  // Cleanup: cancel the order; the resulting roll-up restores HubSpot's totals.
  const c = await marks();
  await sb(`orders?id=eq.${order.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
  await poll(async () => {
    const r = await newOutbox(c, customer.id);
    return r.length && r.every((x) => FINAL.has(x.status)) ? r : null;
  }, 120_000);
  const restored = await contact(contactId);
  check('2', 'cleanup: cancelling the order restored the roll-ups', ROLLUP.every((p) => (restored.props[p] ?? '') === (before.props[p] ?? '')));
}

// ------------------------------------------------------------------ 3. Idempotency
{
  const [row] = replayId
    ? await sb(`sync_inbox?id=eq.${replayId}&select=id,payload`)
    : await sb('sync_inbox?status=eq.done&select=id,payload&order=id.desc&limit=1');
  if (!row) {
    check('3', 'a processed webhook exists to replay', false);
  } else {
    const m = await marks();
    const body = JSON.stringify([row.payload]);
    const fresh = await signedPost(body);
    console.log(`\n${now()}  replayed inbox #${row.id} (fresh signature): HTTP ${fresh.status}`);
    await sleep(8000);
    check('3', 'replay accepted (204)', fresh.status === 204);
    check('3', 'no new inbox row', (await maxId('sync_inbox')) === m.inbox);
    const logs = await newLog(m);
    const id = String(row.payload.objectId);
    check('3', 'activity logs the duplicate as ignored', logs.some((l) => l.action === 'webhook' && /duplicates? ignored/.test(l.outcome)),
      logs.map((l) => `${l.at} ${l.action} ${l.outcome}`).join('; '));
    check('3', 'nothing re-processed', !logs.some((l) => l.object_id === id && l.action !== 'webhook'));
    const stale = await signedPost(body, 10 * 60_000);
    check('3', 'same request signed 10 min ago is rejected (401)', stale.status === 401);
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${now()}  ${failed ? `FAIL: ${failed} of ${results.length} checks failed` : `PASS: all ${results.length} checks`}`);
console.log('Restore the demo afterwards: node scripts/demo-reset.mjs --yes');
process.exit(failed ? 1 : 0);
