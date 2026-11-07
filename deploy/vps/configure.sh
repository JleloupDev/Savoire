#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Prepare deploy/compose/.env : pose les questions, genere les secrets.
# Relance sans risque : une valeur deja remplie est gardee (les secrets ne
# changent jamais). Appele par install.sh ; utilisable seul.
#
# Sans question (installation automatique) : exporter les variables avant,
# avec les memes noms que dans .env, et SAVOIRE_NONINTERACTIVE=1.
#   SAVOIRE_DOMAIN=savoire.exemple.fr ADMIN_EMAIL=moi@exemple.fr \
#   SMTP_USER=... SMTP_PASSWORD=... SAVOIRE_NONINTERACTIVE=1 ./configure.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$HERE/../compose}"
ENV_FILE="$COMPOSE_DIR/.env"
NONINTERACTIVE="${SAVOIRE_NONINTERACTIVE:-0}"

say() { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }

if [ ! -f "$ENV_FILE" ]; then
  cp "$COMPOSE_DIR/.env.example" "$ENV_FILE"
  # Les valeurs d'exemple ne doivent pas rester : elles sont videes.
  sed -i -E 's/^(SAVOIRE_DOMAIN|AUTH_DOMAIN|ACME_EMAIL|ADMIN_EMAIL|ALERT_EMAIL|SMTP_FROM)=.*/\1=/' "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }

set_var() {
  local key="$1" value="$2"
  if grep -qE "^$key=" "$ENV_FILE"; then
    # Remplacement sans sed : la valeur peut contenir / & | ...
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
}

# secret <longueur> : lettres et chiffres.
secret() { openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
# Mot de passe accepte par Zitadel (majuscule, minuscule, chiffre, symbole).
password() { printf 'Sv-%s9!' "$(secret 20)"; }

# ask <CLE> <question> [defaut] [secret]
ask() {
  local key="$1" question="$2" default="${3:-}" hidden="${4:-}" current value
  current="$(get "$key")"
  if [ -n "$current" ]; then return; fi
  value="${!key:-}"
  if [ -z "$value" ] && [ "$NONINTERACTIVE" != "1" ]; then
    local prompt="$question"
    [ -n "$default" ] && prompt="$prompt [$default]"
    if [ -n "$hidden" ]; then read -r -s -p "$prompt : " value; echo; else read -r -p "$prompt : " value; fi
  fi
  value="${value:-$default}"
  set_var "$key" "$value"
}

# generate <CLE> <valeur> : seulement si vide.
generate() { [ -n "$(get "$1")" ] || set_var "$1" "$2"; }

say "── Adresses ──"
ask SAVOIRE_DOMAIN "Domaine de l'appli (ex. savoire.exemple.fr)"
domain="$(get SAVOIRE_DOMAIN)"
ask AUTH_DOMAIN "Domaine de la connexion" "auth.$domain"
ask ADMIN_EMAIL "Votre adresse (administrateur de Savoire, de Zitadel et de GlitchTip)"
admin="$(get ADMIN_EMAIL)"
ask ACME_EMAIL "Adresse pour Let's Encrypt (certificats)" "$admin"
ask ALERT_EMAIL "Adresse qui recoit les alertes" "$admin"

say "── Courriels (Brevo) ──"
echo "Brevo > SMTP & API > onglet SMTP : identifiant SMTP et une cle SMTP."
ask SMTP_USER "Identifiant SMTP (xxxx@smtp-brevo.com)"
ask SMTP_PASSWORD "Cle SMTP" "" secret
parent="${domain#*.}"
ask SMTP_FROM "Expediteur (une adresse du domaine verifie chez Brevo)" "noreply@$parent"
generate SMTP_SERVER smtp-relay.brevo.com
generate SMTP_PORT 465
set_var SMTP_HOST "$(get SMTP_SERVER):$(get SMTP_PORT)"

say "── Copie hors de la machine (restic, S3) ──"
echo "Laisser vide pour plus tard : une alerte le rappellera."
ask RESTIC_REPOSITORY "Depot (ex. s3:https://s3.fr-par.scw.cloud/mon-bucket/savoire)"
if [ -n "$(get RESTIC_REPOSITORY)" ]; then
  ask RESTIC_S3_ACCESS_KEY "Cle d'acces S3"
  ask RESTIC_S3_SECRET_KEY "Cle secrete S3" "" secret
  ask RESTIC_S3_REGION "Region S3 (ex. fr-par, laisser vide si inconnue)"
fi

say "── Secrets (generes) ──"
generate ADMIN_PASSWORD "$(password)"
generate POSTGRES_PASSWORD "$(secret 32)"
generate SAVOIRE_DB_PASSWORD "$(secret 32)"
generate ZITADEL_DB_PASSWORD "$(secret 32)"
generate GLITCHTIP_DB_PASSWORD "$(secret 32)"
generate ZITADEL_MASTERKEY "$(secret 32)"
generate LOGIN_COOKIE_SECRET "$(secret 40)"
generate JWT_SECRET "$(secret 48)"
generate GLITCHTIP_SECRET_KEY "$(secret 50)"
generate GRAFANA_ADMIN_PASSWORD "$(secret 24)"
generate GLITCHTIP_ADMIN_PASSWORD "$(password)"
generate RESTIC_PASSWORD "$(secret 40)"
generate COMPOSE_FILE "docker-compose.yml:docker-compose.ops.yml"
mkdir -p "$COMPOSE_DIR/backups" "$COMPOSE_DIR/metrics"

# Verifications simples.
for key in SAVOIRE_DOMAIN AUTH_DOMAIN ADMIN_EMAIL SMTP_USER SMTP_PASSWORD SMTP_FROM; do
  [ -n "$(get "$key")" ] || warn "$key est vide : a remplir dans $ENV_FILE avant de demarrer."
done
[ "$(get ZITADEL_MASTERKEY | tr -d '\n' | wc -c)" = 32 ] || warn "ZITADEL_MASTERKEY doit faire exactement 32 caracteres."

cat <<EOF

Configuration ecrite dans $ENV_FILE (lisible par root seulement).

A GARDER AILLEURS QUE SUR CETTE MACHINE (gestionnaire de mots de passe) :
  - le fichier .env entier, ou au moins :
  - RESTIC_PASSWORD     : $(get RESTIC_PASSWORD)
  - ZITADEL_MASTERKEY   : $(get ZITADEL_MASTERKEY)
Sans RESTIC_PASSWORD, la copie hors machine est illisible.

Comptes :
  - Savoire et Zitadel : $(get ADMIN_EMAIL) / $(get ADMIN_PASSWORD)
  - Grafana            : admin / $(get GRAFANA_ADMIN_PASSWORD)
  - GlitchTip          : $(get ADMIN_EMAIL) / $(get GLITCHTIP_ADMIN_PASSWORD)
EOF
