#!/usr/bin/env bash
# Stores drain_url and drain_secret in Supabase Vault (create or update). Values never printed.
# Reads SUPABASE_DB_URL and DRAIN_SECRET from .env.local (parsed, not executed as shell).
# Values reach psql only through environment variables, never on a command line.
# Usage: bash scripts/set-vault-secrets.sh https://<vercel-domain>/api/drain
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Git Bash paths (/d/...) mean nothing to Node on Windows; convert when cygpath exists.
NODE_ROOT="$(cygpath -m "$ROOT" 2>/dev/null || echo "$ROOT")"
DRAIN_URL="${1:?usage: set-vault-secrets.sh <drain url>}"
read_env() {
  node --input-type=module -e "
    const { pathToFileURL } = await import('node:url');
    const { readEnvFile } = await import(pathToFileURL(process.argv[1]).href);
    const v = readEnvFile(process.argv[2])[process.argv[3]];
    if (!v) { console.error(process.argv[3] + ' missing from .env.local'); process.exit(1); }
    process.stdout.write(v);" "$NODE_ROOT/scripts/lib/env-file.mjs" "$NODE_ROOT/.env.local" "$1"
}
SUPABASE_DB_URL="$(read_env SUPABASE_DB_URL)"
DRAIN_SECRET="$(read_env DRAIN_SECRET)"
export SUPABASE_DB_URL DRAIN_SECRET DRAIN_URL

MSYS_NO_PATHCONV=1 docker run --rm -i -e SUPABASE_DB_URL -e DRAIN_SECRET -e DRAIN_URL supabase/postgres:17.11.0.004 \
  sh -c 'psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -qtA' <<'SQL'
\set url `printenv DRAIN_URL`
\set secret `printenv DRAIN_SECRET`
\o /dev/null
select vault.update_secret(id, :'url')    from vault.secrets where name = 'drain_url';
select vault.create_secret(:'url', 'drain_url')       where not exists (select 1 from vault.secrets where name = 'drain_url');
select vault.update_secret(id, :'secret') from vault.secrets where name = 'drain_secret';
select vault.create_secret(:'secret', 'drain_secret') where not exists (select 1 from vault.secrets where name = 'drain_secret');
\o
select 'vault secrets set: ' || count(*) from vault.secrets where name in ('drain_url', 'drain_secret');
SQL
