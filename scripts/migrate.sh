#!/usr/bin/env bash
# Applies new SQL migrations to the Supabase database in .env.local (SUPABASE_DB_URL), in filename order.
# Each migration and its record in private.schema_migrations run in one transaction: a failed migration
# is never marked as applied. Needs Docker (uses the Supabase Postgres image for psql).
#
#   bash scripts/migrate.sh              apply pending migrations
#   bash scripts/migrate.sh --status     list applied / pending, change nothing
#   bash scripts/migrate.sh --baseline   mark every migration as applied WITHOUT running it
#                                        (only for a database migrated before this runner existed)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/lib/read-env.sh"
MODE="${1:-apply}"
IMAGE="supabase/postgres:17.11.0.004"

# An already-exported SUPABASE_DB_URL wins (CI, or a throwaway local database).
SUPABASE_DB_URL="${SUPABASE_DB_URL:-$(read_env SUPABASE_DB_URL)}"
export SUPABASE_DB_URL

psql_db() {
  MSYS_NO_PATHCONV=1 docker run --rm -i -e SUPABASE_DB_URL "$IMAGE" \
    sh -c 'psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -qtA "$@"' psql "$@" 2>&1 \
    | sed -E 's#postgres(ql)?://[^ ]*#<db-url>#g'
  return "${PIPESTATUS[0]}"
}

psql_db <<'SQL' >/dev/null
create schema if not exists private;
create table if not exists private.schema_migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);
SQL

APPLIED="$(echo 'select filename from private.schema_migrations order by filename;' | psql_db)"

pending=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$f")"
  if grep -qxF "$name" <<<"$APPLIED"; then
    [ "$MODE" = "--status" ] && echo "applied  $name"
    continue
  fi
  pending=$((pending + 1))
  case "$MODE" in
    --status)
      echo "pending  $name" ;;
    --baseline)
      echo "insert into private.schema_migrations (filename) values ('$name');" | psql_db >/dev/null
      echo "baselined $name" ;;
    apply)
      echo "applying $name"
      { cat "$f"; printf "\ninsert into private.schema_migrations (filename) values ('%s');\n" "$name"; } \
        | psql_db --single-transaction >/dev/null \
        || { echo "FAILED: $name (rolled back, not recorded)"; exit 1; } ;;
    *)
      echo "unknown option $MODE"; exit 2 ;;
  esac
done
[ "$pending" -eq 0 ] && [ "$MODE" != "--status" ] && echo "database is up to date"
exit 0
