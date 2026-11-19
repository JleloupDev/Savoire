#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Reinstalle Savoire depuis la copie hors machine (restic), sur une machine
# neuve ou sur celle-ci. A lancer avec sudo (il passe sous le compte savoire), apres install.sh --restore (qui
# l'appelle) ou seul.
#
#  1. Lit la derniere copie : export des bases, fichiers des vaults, .env,
#     jetons de service de Zitadel.
#  2. Remet le .env d'origine (ses secrets ouvrent les donnees).
#  3. Demarre PostgreSQL seul, y recharge les bases.
#  4. Remet les fichiers des vaults et les jetons de Zitadel (il ne les ecrit
#     qu'a sa premiere installation : avec une base restauree, il ne les
#     recree pas, et la connexion ne demarrerait pas), puis demarre tout.
#
# Il faut : l'adresse du depot, ses cles S3 et RESTIC_PASSWORD (gardes hors de
# la machine). Questions posees si les variables ne sont pas exportees.
#
# ATTENTION : sur une machine qui tourne deja, les bases et les fichiers
# actuels sont REMPLACES par ceux de la copie.
set -euo pipefail

SAVOIRE_DIR="${SAVOIRE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# Sous le compte de Savoire (sans sudo, son Docker) : lance en root, il s'y relance.
. "$SAVOIRE_DIR/deploy/vps/lib.sh"
as_owner "$SAVOIRE_DIR/deploy/vps/restore.sh" "$@"
COMPOSE_DIR="$SAVOIRE_DIR/deploy/compose"
RESTIC_IMAGE="restic/restic:${RESTIC_VERSION:-0.19.1}"

cd "$COMPOSE_DIR"

read_var() {
  local key="$1" question="$2" hidden="${3:-}" value="${!1:-}"
  if [ -z "$value" ] && [ -f .env ]; then value="$(grep -E "^$key=" .env | tail -1 | cut -d= -f2- || true)"; fi
  if [ -z "$value" ]; then
    if [ -n "$hidden" ]; then read -r -s -p "$question : " value; echo; else read -r -p "$question : " value; fi
  fi
  printf -v "$key" '%s' "$value"
  export "${key?}"
}
read_var RESTIC_REPOSITORY "Depot restic (s3:https://.../savoire)"
read_var RESTIC_S3_ACCESS_KEY "Cle d'acces S3"
read_var RESTIC_S3_SECRET_KEY "Cle secrete S3" secret
read_var RESTIC_S3_REGION "Region S3 (vide si inconnue)"
read_var RESTIC_PASSWORD "RESTIC_PASSWORD" secret

work="$(mktemp -d /var/tmp/savoire-restore.XXXXXX)"
trap 'rm -rf "$work"' EXIT

echo "== Lecture de la derniere copie"
docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e AWS_ACCESS_KEY_ID="$RESTIC_S3_ACCESS_KEY" -e AWS_SECRET_ACCESS_KEY="$RESTIC_S3_SECRET_KEY" \
  -e AWS_DEFAULT_REGION="$RESTIC_S3_REGION" \
  -v "$work:/restore" "$RESTIC_IMAGE" restore latest --host savoire --tag savoire --target /restore
dump="$work/tmp/db/savoire-db.sql.gz"
[ -f "$dump" ] || { echo "Pas d'export des bases dans la copie." >&2; exit 1; }

echo "== Configuration (.env) de la copie"
if [ -f "$work/config/savoire.env" ]; then
  [ -f .env ] && cp .env ".env.avant-restauration.$(date +%Y%m%d%H%M%S)"
  install -m 600 "$work/config/savoire.env" .env
else
  echo "La copie n'a pas de .env : celui de cette machine est garde (il doit avoir les memes secrets)." >&2
  [ -f .env ] || { echo "Aucun .env : lancer configure.sh avec les secrets d'origine." >&2; exit 1; }
fi
mkdir -p backups metrics

echo "== Arret de Savoire"
docker compose down --remove-orphans || true

echo "== Bases"
docker compose up -d --wait postgres
gunzip -c "$dump" | docker compose exec -T postgres psql -q -U postgres -d postgres >/dev/null 2>"$work/psql.log" || true
# Erreurs attendues : roles deja la, role postgres impossible a supprimer.
if grep -vE 'role "postgres"|already exists|current user cannot be dropped' "$work/psql.log" | grep -q ERROR; then
  echo "Erreurs pendant le rechargement :" >&2
  grep ERROR "$work/psql.log" | head -20 >&2
fi

echo "== Fichiers des vaults"
project="$(docker compose config --format json | jq -r .name)"
docker run --rm -v "${project}_savoire-data:/data" -v "$work/data:/from:ro" alpine:3.22 \
  sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; cp -a /from/. /data/'

echo "== Jetons de service de Zitadel"
if [ -s "$work/bootstrap/admin.pat" ] && [ -s "$work/bootstrap/login-client.pat" ]; then
  docker run --rm -v "${project}_zitadel-bootstrap:/bootstrap" -v "$work/bootstrap:/from:ro" alpine:3.22 \
    sh -c 'rm -rf /bootstrap/* 2>/dev/null; cp -a /from/. /bootstrap/'
else
  echo "La copie n'a pas les jetons de Zitadel (copie d'avant le 17/11/2026) :" >&2
  echo "la page de connexion et le bootstrap ne demarreront pas. Voir SELF_HOSTING.md, « Restaurer »." >&2
  exit 1
fi

echo "== Demarrage"
docker compose up -d --wait --wait-timeout 600 || true
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
# Verification : l'API repond et sa base est joignable.
if docker compose exec -T api bash -c "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /health/ready HTTP/1.0\r\n\r\n' >&3 && grep -q ' 200 ' <&3"; then
  echo "Restauration terminee : l'API repond."
else
  echo "Restauration faite, mais l'API ne repond pas : docker compose logs api zitadel-bootstrap" >&2
  exit 1
fi
