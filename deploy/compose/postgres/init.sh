#!/bin/sh
# Premier demarrage de PostgreSQL : une base et un role par application.
# Savoire (backend), Zitadel (identites) et GlitchTip (suivi des erreurs,
# docker-compose.ops.yml) partagent le serveur, pas la base.
# Relance sans effet : le dossier de donnees existe deja.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE savoire LOGIN PASSWORD '${SAVOIRE_DB_PASSWORD}';
CREATE DATABASE savoire OWNER savoire;
CREATE ROLE zitadel LOGIN PASSWORD '${ZITADEL_DB_PASSWORD}';
CREATE DATABASE zitadel OWNER zitadel;
SQL

if [ -n "${GLITCHTIP_DB_PASSWORD:-}" ]; then
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE glitchtip LOGIN PASSWORD '${GLITCHTIP_DB_PASSWORD}';
CREATE DATABASE glitchtip OWNER glitchtip;
SQL
fi
