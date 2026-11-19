#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Deploiement par la CI (.github/workflows/deploy.yml), sous le compte savoire
# (sans sudo, Docker rootless). La cle SSH de la CI ne peut lancer que ce
# script (commande imposee, posee par install.sh --ci) :
#
#   command="bash /opt/savoire/deploy/vps/ci-deploy.sh \"$SSH_ORIGINAL_COMMAND\"",restrict ssh-ed25519 ...
#
# La CI envoie le .env sur l'entree standard (il est fait des secrets et
# variables de l'environnement GitHub « production ») et, en commande, ce qu'il
# faut deployer : un commit (40 caracteres hexadecimaux) ou une etiquette
# v1.2.3. Les images sont celles de ce commit (sha-abc1234) ou de l'etiquette.
#
#  1. Fichiers de deploiement (git) a ce commit, puis la suite avec le script
#     de ce commit.
#  2. .env verifie : les secrets qui ouvrent les donnees ne changent jamais.
#  3. Sauvegarde si Savoire tourne deja, nouvelles images, demarrage.
#  4. Attend que l'API et le site repondent.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAVOIRE_DIR="$(cd "$HERE/../.." && pwd)"
COMPOSE_DIR="$SAVOIRE_DIR/deploy/compose"

fail() { echo "ci-deploy : $*" >&2; exit 1; }
# shellcheck source=lib.sh
. "$HERE/lib.sh"
[ "$(id -un)" = "$(stat -c %U "$SAVOIRE_DIR")" ] \
  || fail "a lancer sous le compte qui possede $SAVOIRE_DIR ($(stat -c %U "$SAVOIRE_DIR"))."

# ── Etape 1 : lire l'entree, poser les fichiers du commit, relancer ────────
if [ "${SAVOIRE_CI_STAGE:-1}" = 1 ]; then
  ref="${1:-}"
  if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
    version="sha-${ref:0:7}"
  elif [[ "$ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$ ]]; then
    version="$ref"
  else
    fail "commande refusee : un commit (40 caracteres) ou une etiquette v1.2.3 attendu, lu « $ref »."
  fi

  env_in="$(mktemp)"
  chmod 600 "$env_in"
  head -c 1048576 > "$env_in"
  [ -s "$env_in" ] || { rm -f "$env_in"; fail "aucun .env recu sur l'entree standard."; }

  echo "== Fichiers de deploiement : $ref"
  git -C "$SAVOIRE_DIR" fetch -q --tags origin
  git -C "$SAVOIRE_DIR" checkout -q --detach "$ref"

  # La suite avec le script de ce commit (il a pu changer).
  SAVOIRE_CI_STAGE=2 exec bash "$SAVOIRE_DIR/deploy/vps/ci-deploy.sh" "$version" "$env_in"
fi

# ── Etape 2 : .env, sauvegarde, images, demarrage ──────────────────────────
version="$1"
env_in="$2"
trap 'rm -f "$env_in" "$env_in.new"' EXIT
cd "$COMPOSE_DIR"

val() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- || true; }

for key in SAVOIRE_DOMAIN AUTH_DOMAIN ADMIN_EMAIL ADMIN_PASSWORD POSTGRES_PASSWORD \
           SAVOIRE_DB_PASSWORD ZITADEL_DB_PASSWORD ZITADEL_MASTERKEY \
           LOGIN_COOKIE_SECRET JWT_SECRET SMTP_USER SMTP_PASSWORD SMTP_FROM; do
  [ -n "$(val "$key" "$env_in")" ] || fail "$key manque dans les secrets ou variables GitHub (environnement production)."
done
[ "$(val ZITADEL_MASTERKEY "$env_in" | tr -d '\n' | wc -c)" = 32 ] || fail "ZITADEL_MASTERKEY doit faire exactement 32 caracteres."

# Ces valeurs ouvrent des donnees deja ecrites : les changer casse Savoire,
# ses bases ou sa copie hors machine. Pour en changer une, il faut le faire
# aussi dans les donnees, a la main, puis retirer la ligne du .env du serveur.
if [ -f .env ]; then
  for key in ZITADEL_MASTERKEY POSTGRES_PASSWORD SAVOIRE_DB_PASSWORD ZITADEL_DB_PASSWORD \
             GLITCHTIP_DB_PASSWORD STORE_DB_PASSWORD STORE_SIGNING_KEY RESTIC_PASSWORD; do
    old="$(val "$key" .env)"; new="$(val "$key" "$env_in")"
    if [ -n "$old" ] && [ "$old" != "$new" ]; then
      fail "$key differe de celui du serveur : refuse (il ouvre des donnees deja ecrites)."
    fi
  done
fi

grep -vE '^SAVOIRE_VERSION=' "$env_in" > "$env_in.new" || true
echo "SAVOIRE_VERSION=$version" >> "$env_in.new"

running=0
[ -f .env ] && [ -n "$(docker compose ps -q api 2>/dev/null)" ] && running=1

install -m 600 "$env_in.new" .env
mkdir -p backups metrics

if [ "$running" = 1 ]; then
  echo "== Sauvegarde avant mise a jour"
  docker compose run --rm --no-deps backup now
  docker compose run --rm --no-deps offsite now 2>/dev/null \
    || echo "Copie hors machine impossible (voir offsite) : on continue." >&2
fi

echo "== Images ($version)"
docker compose pull -q
docker compose up -d --remove-orphans
docker image prune -f >/dev/null

echo "== Attente des services"
domain="$(val SAVOIRE_DOMAIN .env)"
auth="$(val AUTH_DOMAIN .env)"
# Le site est appele par 127.0.0.1 : il passe par Caddy et son certificat,
# sans dependre du retour de la machine sur sa propre adresse publique.
ok=0
for _ in $(seq 1 72); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q api)" 2>/dev/null || true)"
  site="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/" || true)"
  login="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$auth:443:127.0.0.1" "https://$auth/ui/v2/login/healthy" || true)"
  if [ "$health" = healthy ] && [ "$site" = 200 ] && [ "$login" = 200 ]; then ok=1; break; fi
  sleep 5
done
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
[ "$ok" = 1 ] || fail "apres 6 minutes : api=$health, site=$site, connexion=$login."
echo "Savoire $version est en ligne : https://$domain"
