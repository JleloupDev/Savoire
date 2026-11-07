#!/bin/sh
# Sauvegarde de nuit (service « backup » de docker-compose.yml) :
#  - les deux bases PostgreSQL (Savoire, Zitadel), en un seul fichier
#    (pg_dumpall : roles compris) ;
#  - les fichiers des vaults (volume savoire-data, pieces jointes).
# Garde BACKUP_KEEP_DAYS jours dans /backups. La copie hors de la machine est
# faite ensuite par le service « offsite » (restic, docker-compose.ops.yml).
set -eu

KEEP="${BACKUP_KEEP_DAYS:-14}"
AT="${BACKUP_AT:-03:30}"

run() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  tmp="/backups/.savoire-$stamp"
  pg_dumpall --clean --if-exists | gzip -6 > "$tmp-db.sql.gz"
  tar -C /data -czf "$tmp-files.tar.gz" .
  mv "$tmp-db.sql.gz" "/backups/savoire-$stamp-db.sql.gz"
  mv "$tmp-files.tar.gz" "/backups/savoire-$stamp-files.tar.gz"
  find /backups -maxdepth 1 -name 'savoire-*' -mtime +"$KEEP" -delete
  metric savoire_backup_last_success_timestamp_seconds "$(date -u +%s)" \
    "Fin de la derniere sauvegarde locale reussie (secondes Unix)."
  echo "sauvegarde $stamp terminee"
}

# Metriques lues par node-exporter (collecteur « textfile ») : l'alerte
# « sauvegarde manquee » de Prometheus s'appuie dessus. Sans dossier, rien.
metric() {
  [ -d /metrics ] || return 0
  printf '# HELP %s %s\n# TYPE %s gauge\n%s %s\n' "$1" "$3" "$1" "$1" "$2" > "/metrics/.$1.tmp"
  mv "/metrics/.$1.tmp" "/metrics/$1.prom"
}

# « backup.sh now » : une sauvegarde tout de suite, puis fin.
if [ "${1:-}" = "now" ]; then run; exit 0; fi

while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) $AT" +%s 2>/dev/null || echo $((now + 86400)))
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  run || echo "sauvegarde en echec" >&2
done
