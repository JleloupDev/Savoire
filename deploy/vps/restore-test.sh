#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Test de restauration (chaque dimanche, minuterie savoire-restore-test) :
# une sauvegarde n'existe que si on sait la relire. Sans toucher a Savoire :
#
#  1. relit la derniere copie hors machine (restic) dans un dossier jetable ;
#  2. recharge l'export dans un PostgreSQL jetable, en memoire ;
#  3. verifie que les bases de Savoire et de Zitadel sont la et lisibles,
#     et que les fichiers des vaults et le .env sont dans la copie ;
#  4. note la reussite (metrique savoire_restore_test_last_success_timestamp_seconds) :
#     sans reussite depuis 8 jours, une alerte part.
set -euo pipefail

SAVOIRE_DIR="${SAVOIRE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
COMPOSE_DIR="$SAVOIRE_DIR/deploy/compose"
PG_IMAGE="postgres:17.10-alpine"
NAME="savoire-restore-test"
cd "$COMPOSE_DIR"

work="$(mktemp -d /var/tmp/savoire-restore-test.XXXXXX)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

echo "== Lecture de la derniere copie"
docker compose run --rm --no-deps -T -v "$work:/restore" offsite restore /restore
dump="$work/tmp/db/savoire-db.sql.gz"
[ -s "$dump" ] || { echo "ECHEC : pas d'export des bases dans la copie." >&2; exit 1; }
[ -d "$work/data" ] || { echo "ECHEC : pas de fichiers des vaults dans la copie." >&2; exit 1; }
[ -s "$work/config/savoire.env" ] || { echo "ECHEC : pas de .env dans la copie." >&2; exit 1; }
gunzip -t "$dump"

echo "== Rechargement dans un PostgreSQL jetable"
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=restore-test --tmpfs /var/lib/postgresql/data:rw "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -q && break
  sleep 1
done
gunzip -c "$dump" | docker exec -i "$NAME" psql -q -U postgres -d postgres >/dev/null 2>"$work/psql.log" || true

q() { docker exec "$NAME" psql -U postgres -d "$1" -tAc "$2"; }
migrations="$(q savoire 'select count(*) from "__EFMigrationsHistory"')"
vaults="$(q savoire 'select count(*) from vaults')"
zitadel="$(q zitadel "select count(*) from information_schema.schemata where schema_name in ('eventstore','projections')")"
files="$(find "$work/data" -type f | wc -l)"
echo "Savoire : $migrations migrations, $vaults vaults ; Zitadel : $zitadel schemas ; fichiers : $files"
[ "$migrations" -gt 0 ] || { echo "ECHEC : base de Savoire vide." >&2; exit 1; }
[ "$zitadel" -ge 1 ] || { echo "ECHEC : base de Zitadel absente." >&2; exit 1; }

metrics_dir="$(grep -E '^METRICS_DIR=' .env | cut -d= -f2- || true)"
metrics_dir="${metrics_dir:-./metrics}"
mkdir -p "$metrics_dir"
{
  echo "# HELP savoire_restore_test_last_success_timestamp_seconds Dernier test de restauration reussi (secondes Unix)."
  echo "# TYPE savoire_restore_test_last_success_timestamp_seconds gauge"
  echo "savoire_restore_test_last_success_timestamp_seconds $(date -u +%s)"
} > "$metrics_dir/.restore.tmp"
mv "$metrics_dir/.restore.tmp" "$metrics_dir/savoire_restore_test_last_success_timestamp_seconds.prom"
echo "Test de restauration reussi."
