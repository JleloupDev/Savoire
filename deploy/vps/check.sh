#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Etat de Savoire en un coup d'oeil (root) : services, site, alertes en cours,
# age des sauvegardes.
set -uo pipefail

SAVOIRE_DIR="${SAVOIRE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$SAVOIRE_DIR/deploy/compose" || exit 1
env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }

echo "== Services"
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'

echo; echo "== Site"
for url in "https://$(env_get SAVOIRE_DOMAIN)/" "https://$(env_get AUTH_DOMAIN)/ui/v2/login/healthy"; do
  printf '%-60s %s\n' "$url" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url")"
done

port="$(env_get PROMETHEUS_PORT)"; port="${port:-9090}"
echo; echo "== Alertes en cours"
curl -s --max-time 5 "http://127.0.0.1:$port/api/v1/alerts" \
  | jq -r '.data.alerts[] | select(.state=="firing") | "\(.labels.severity)\t\(.labels.alertname)\t\(.annotations.summary)"' 2>/dev/null \
  | sed 's/^/  /' | grep . || echo "  aucune"

echo; echo "== Sauvegardes (age)"
now=$(date +%s)
for f in metrics/*.prom; do
  [ -f "$f" ] || continue
  ts=$(awk '!/^#/ {print $2}' "$f")
  printf '  %-60s %s h\n' "$(basename "$f" .prom)" "$(( (now - ${ts%.*}) / 3600 ))"
done
