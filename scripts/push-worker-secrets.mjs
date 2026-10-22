// Copies configuration from .env.local into the Cloudflare Worker as secrets (`wrangler secret bulk`).
// Generates DRAIN_SECRET, CRON_SECRET and RATE_LIMIT_SALT into .env.local if missing.
// Prints names and ok/failed only, never values. The values pass through a temporary file that only this
// user can read, and it is deleted straight after the upload.
// Usage: node scripts/push-worker-secrets.mjs   (needs `wrangler login` once; run `npm ci` in web/ first)
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEnv, readEnvFile } from './lib/env-file.mjs';

const root = path.resolve(import.meta.dirname, '..');
const web = path.join(root, 'web');
const envPath = path.join(root, '.env.local');
// Called through node: npm/npx shims break when the folder path contains `&`.
const wrangler = path.join(web, 'node_modules/wrangler/bin/wrangler.js');

let env = readEnvFile(envPath);
for (const name of ['DRAIN_SECRET', 'CRON_SECRET', 'RATE_LIMIT_SALT']) {
  if (!env[name]) {
    appendEnv(envPath, name, crypto.randomBytes(32).toString('base64url'));
    console.log(`${name}: generated into .env.local`);
  }
}
env = readEnvFile(envPath);

// SUPABASE_URL is derivable from the pooler user name (postgres.<project-ref>).
if (!env.SUPABASE_URL && env.SUPABASE_DB_URL) {
  const ref = env.SUPABASE_DB_URL.match(/\/\/postgres\.([a-z0-9]+):/)?.[1];
  if (ref) env.SUPABASE_URL = `https://${ref}.supabase.co`;
}

const NAMES = [
  'HUBSPOT_TOKEN', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_APP_ID', 'HUBSPOT_PORTAL_ID',
  'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'DRAIN_SECRET', 'CRON_SECRET', 'RATE_LIMIT_SALT',
];
const missing = NAMES.filter((n) => !env[n]);
if (missing.length) {
  for (const n of missing) console.log(`${n}: MISSING in .env.local`);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-secrets-'));
const file = path.join(dir, 'secrets.json');
let ok = false;
try {
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(NAMES.map((n) => [n, env[n]]))), { mode: 0o600 });
  const r = spawnSync(process.execPath, [wrangler, 'secret', 'bulk', file], { cwd: web, encoding: 'utf8' });
  ok = r.status === 0;
  // Wrangler's output is not echoed: it is not needed and must never risk containing a value.
  if (!ok) console.log(`wrangler secret bulk failed (exit ${r.status}); check \`wrangler whoami\``);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
for (const n of NAMES) console.log(`${n}: ${ok ? 'ok' : 'not set'}`);
process.exit(ok ? 0 : 1);
