#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Met Savoire a jour (sudo, ou sous le compte savoire) : sauvegarde d'abord, puis les fichiers de
# deploiement (git), les images, le redemarrage des services changes.
# La version vient de SAVOIRE_VERSION dans .env (latest, v1.2.0, sha-abc1234).
set -euo pipefail

SAVOIRE_DIR="${SAVOIRE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# Sous le compte de Savoire (sans sudo, son Docker) : lance en root, il s'y relance.
. "$SAVOIRE_DIR/deploy/vps/lib.sh"
as_owner "$SAVOIRE_DIR/deploy/vps/update.sh" "$@"
cd "$SAVOIRE_DIR/deploy/compose"

echo "== Sauvegarde avant mise a jour"
docker compose run --rm --no-deps backup now
docker compose run --rm --no-deps offsite now || echo "Copie hors machine impossible (voir offsite) : on continue." >&2

echo "== Fichiers de deploiement"
if git -C "$SAVOIRE_DIR" symbolic-ref -q HEAD >/dev/null; then
  git -C "$SAVOIRE_DIR" pull --ff-only
else
  # Deploye par la CI (ci-deploy.sh) : un commit precis, pas une branche.
  echo "Commit fixe par la CI ($(git -C "$SAVOIRE_DIR" rev-parse --short HEAD)) : fichiers gardes."
fi

echo "== Images"
docker compose pull -q
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
