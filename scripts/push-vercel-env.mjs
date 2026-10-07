// Copies configuration from .env.local into the Vercel project (production), values via stdin.
// Generates DRAIN_SECRET into .env.local if missing. Prints names and ok/failed only, never values.
// Usage: node scripts/push-vercel-env.mjs
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { appendEnv, readEnvFile } from './lib/env-file.mjs';

const root = path.resolve(import.meta.dirname, '..');
const envPath = path.join(root, '.env.local');
const vc = path.join(process.env.APPDATA ?? '', 'npm/node_modules/vercel/dist/vc.js');

let env = readEnvFile(envPath);
if (!env.DRAIN_SECRET) {
  appendEnv(envPath, 'DRAIN_SECRET', crypto.randomBytes(32).toString('base64url'));
  env = readEnvFile(envPath);
  console.log('DRAIN_SECRET: generated into .env.local');
}

// SUPABASE_URL is derivable from the pooler user name (postgres.<project-ref>).
if (!env.SUPABASE_URL && env.SUPABASE_DB_URL) {
  const ref = env.SUPABASE_DB_URL.match(/\/\/postgres\.([a-z0-9]+):/)?.[1];
  if (ref) env.SUPABASE_URL = `https://${ref}.supabase.co`;
}

const VARS = [
  ['HUBSPOT_TOKEN', true],
  ['HUBSPOT_CLIENT_SECRET', true],
  ['SUPABASE_SECRET_KEY', true],
  ['DRAIN_SECRET', true],
  ['HUBSPOT_APP_ID', false],
  ['HUBSPOT_PORTAL_ID', false],
  ['SUPABASE_URL', false],
];

let failed = false;
for (const [name, sensitive] of VARS) {
  const value = env[name];
  if (!value) {
    console.log(`${name}: MISSING in .env.local`);
    failed = true;
    continue;
  }
  const args = [vc, 'env', 'add', name, 'production', '--force', ...(sensitive ? ['--sensitive'] : [])];
  const r = spawnSync(process.execPath, args, { cwd: path.join(root, 'web'), input: value, encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed = true;
  // CLI output is not echoed: it is not needed and must never risk containing a value.
  console.log(`${name}: ${ok ? 'ok' : `failed (exit ${r.status})`}${sensitive ? ' [sensitive]' : ''}`);
}
process.exit(failed ? 1 : 0);
