#!/usr/bin/env bash
# Copy the LOCAL database (docker compose postgres) to Supabase — schema + all data + migration history.
# 1. Add ONE extra line to backend/.env (git-ignored) — do NOT change DATABASE_URL there:
#      SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
#    (backend/.env.deploy also works, if you prefer a separate file)
# 2. Run from the repo root:  bash scripts/copy-db-to-supabase.sh
# Refuses to run if the target already has our tables (no accidental overwrite).
set -euo pipefail
cd "$(dirname "$0")/.."
URL=$(cat backend/.env.deploy backend/.env 2>/dev/null | grep -E '^SUPABASE_DB_URL=' | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r' || true)
[ -n "$URL" ] || { echo "SUPABASE_DB_URL missing — add it as an extra line in backend/.env"; exit 1; }
PSQL=(docker run --rm -i postgres:16-alpine psql "$URL" -v ON_ERROR_STOP=1 -q)

existing=$("${PSQL[@]}" -tA -c "select count(*) from information_schema.tables where table_schema='public' and table_name in ('Order','Customer','_prisma_migrations')")
if [ "${existing//[[:space:]]/}" != "0" ]; then echo "Target already has Wishluck tables — aborting (nothing changed)."; exit 1; fi

DUMP=$(mktemp)
trap 'rm -f "$DUMP"' EXIT
echo "Dumping local database…"
docker compose exec -T postgres pg_dump -U wishluck -d wishluck --schema=public --no-owner --no-privileges \
  | grep -vE '^(CREATE SCHEMA public;|COMMENT ON SCHEMA public)' > "$DUMP"
echo "Restoring into Supabase (single transaction)…"
"${PSQL[@]}" -1 < "$DUMP"
"${PSQL[@]}" -tA -c "select 'orders: '||(select count(*) from \"Order\")||', customers: '||(select count(*) from \"Customer\")||', conversations: '||(select count(*) from \"Conversation\")||', migrations: '||(select count(*) from _prisma_migrations)"
echo "Done."
