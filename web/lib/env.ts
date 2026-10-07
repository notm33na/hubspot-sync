// Server-only configuration. Read lazily so a missing variable fails the request that needs it, with a clear message.
const NAMES = [
  'HUBSPOT_TOKEN',
  'HUBSPOT_CLIENT_SECRET',
  'HUBSPOT_APP_ID',
  'HUBSPOT_PORTAL_ID',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'DRAIN_SECRET',
] as const;

export type EnvName = (typeof NAMES)[number];

export function env(name: EnvName): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
