#!/usr/bin/env bash
# Applies all migrations to a throwaway Supabase Postgres container and runs the schema tests.
# Usage: bash supabase/tests/run.sh      (needs Docker running)
set -euo pipefail

IMAGE="supabase/postgres:17.11.0.004"
NAME="fernhill-schema-test"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# Throwaway local container only; this password never leaves the machine.
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=localtest "$IMAGE" >/dev/null

echo "waiting for postgres..."
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -h localhost >/dev/null 2>&1 \
     && docker exec "$NAME" psql -U postgres -h localhost -tAc "select 1" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

psql_in() { docker exec -i -e PGPASSWORD=localtest "$NAME" psql -U postgres -h localhost -v ON_ERROR_STOP=1 -q "$@"; }

for f in "$DIR"/migrations/*.sql; do
  echo "applying $(basename "$f")"
  psql_in < "$f" >/dev/null
done

echo "running schema tests"
psql_in < "$DIR/tests/schema.test.sql" 2>&1 | grep -E "^(NOTICE|psql|ERROR|ALL)|FAIL" | sed 's/^NOTICE:  //'
