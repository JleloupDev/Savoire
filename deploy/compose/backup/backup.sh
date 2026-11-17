#!/bin/sh
# Sauvegardes (service « backup » de docker-compose.yml), plusieurs fois par
# jour (BACKUP_TIMES, heures UTC) :
#  - les bases PostgreSQL (Savoire, Zitadel, store...), en un seul fichier
#    (pg_dumpall : roles compris) ;
#  - les fichiers des vaults (volume savoire-data, pieces jointes) ;
#  - les jetons de service de Zitadel (volume zitadel-bootstrap) : Zitadel
#    ne les ecrit qu'a sa toute premiere installation. Sans eux, une base
#    restauree ailleurs ne redemarre pas (page de connexion, bootstrap).
# Garde BACKUP_KEEP_DAYS jours dans /backups, lisibles par root seulement
# (le contenu des vaults y est en clair ; la copie hors machine, elle, est
# chiffree : service « offsite », restic, docker-compose.ops.yml).
#
# Une sauvegarde n'est notee reussie (metrique, donc pas d'alerte) que si
# l'export est complet et relisible : un pg_dumpall interrompu laissait un
# fichier tronque, compte comme bon.
set -eu
# Une erreur au milieu d'un tube (pg_dumpall | gzip) fait echouer le tout.
set -o pipefail
umask 077

KEEP="${BACKUP_KEEP_DAYS:-14}"
# Heures de sauvegarde (UTC), separees par des virgules. Ancien reglage : BACKUP_AT (une seule).
TIMES="${BACKUP_TIMES:-${BACKUP_AT:-03:30}}"

# Fin d'un export complet de pg_dumpall.
DUMP_END='PostgreSQL database cluster dump complete'

run() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  tmp="/backups/.savoire-$stamp"
  trap 'rm -f "$tmp-db.sql.gz" "$tmp-files.tar.gz" "$tmp-zitadel.tar.gz"' EXIT
  pg_dumpall --clean --if-exists | gzip -6 > "$tmp-db.sql.gz"
  # Relu : archive intacte, et l'export va jusqu'au bout.
  gzip -t "$tmp-db.sql.gz"
  if ! gunzip -c "$tmp-db.sql.gz" | tail -n 20 | grep -q "$DUMP_END"; then
    echo "sauvegarde $stamp : export des bases incomplet" >&2
    return 1
  fi
  tar -C /data -czf "$tmp-files.tar.gz" .
  gzip -t "$tmp-files.tar.gz"
  if [ -d /bootstrap ]; then
    tar -C /bootstrap -czf "$tmp-zitadel.tar.gz" .
    gzip -t "$tmp-zitadel.tar.gz"
  fi
  mv "$tmp-db.sql.gz" "/backups/savoire-$stamp-db.sql.gz"
  mv "$tmp-files.tar.gz" "/backups/savoire-$stamp-files.tar.gz"
  [ -f "$tmp-zitadel.tar.gz" ] && mv "$tmp-zitadel.tar.gz" "/backups/savoire-$stamp-zitadel.tar.gz"
  trap - EXIT
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
  chmod 644 "/metrics/.$1.tmp"
  mv "/metrics/.$1.tmp" "/metrics/$1.prom"
}

# Prochaine heure de sauvegarde (secondes Unix), parmi TIMES.
next_run() {
  now=$(date -u +%s)
  best=""
  for at in $(echo "$TIMES" | tr ',' ' '); do
    t=$(date -u -d "$(date -u +%Y-%m-%d) $at" +%s 2>/dev/null) || continue
    [ "$t" -le "$now" ] && t=$((t + 86400))
    if [ -z "$best" ] || [ "$t" -lt "$best" ]; then best=$t; fi
  done
  echo "${best:-$((now + 86400))}"
}

# « backup.sh now » : une sauvegarde tout de suite, puis fin.
if [ "${1:-}" = "now" ]; then run; exit 0; fi

while true; do
  next=$(next_run)
  sleep $((next - $(date -u +%s)))
  run || echo "sauvegarde en echec" >&2
done
