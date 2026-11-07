#!/bin/sh
# Copie hors de la machine (service « offsite » de docker-compose.ops.yml),
# avec restic : chiffree, dedoublonnee, vers un stockage S3 (Scaleway, OVH,
# Hetzner, Backblaze...) ou tout depot que restic connait (RESTIC_REPOSITORY).
#
# Apres chaque sauvegarde locale (service « backup ») :
#  - le dernier export des bases (savoire-<date>-db.sql.gz) ;
#  - les fichiers des vaults tels quels (/data) : restic n'envoie que ce qui
#    a change depuis la fois precedente ;
#  - le fichier .env (/config/savoire.env) : ses secrets (cle de Zitadel...)
#    sont indispensables pour relancer Savoire ailleurs. Le depot est chiffre.
# Sans depot configure (RESTIC_REPOSITORY vide), le service attend et le dit ;
# l'alerte « copie hors machine jamais faite » le rappelle.
# Garde 7 jours, 4 semaines, 6 mois. Verifie le depot chaque dimanche.
#
#   offsite.sh                 boucle (toutes les 15 minutes)
#   offsite.sh now             une copie tout de suite, puis fin
#   offsite.sh restore <dir>   restaure la derniere copie dans <dir> (db/ et data/)
#   offsite.sh snapshots       liste des copies
set -eu

STATE=/state
mkdir -p "$STATE"

metric() {
  [ -d /metrics ] || return 0
  printf '# HELP %s %s\n# TYPE %s gauge\n%s %s\n' "$1" "$3" "$1" "$1" "$2" > "/metrics/.$1.tmp"
  mv "/metrics/.$1.tmp" "/metrics/$1.prom"
}

ensure_repo() {
  restic cat config >/dev/null 2>&1 || restic init
}

latest_dump() {
  ls -1 /backups/savoire-*-db.sql.gz 2>/dev/null | sort | tail -1
}

copy() {
  dump=$(latest_dump)
  if [ -z "$dump" ]; then echo "offsite : aucune sauvegarde locale pour l'instant"; return 0; fi
  if [ "${1:-}" != "force" ] && [ -f "$STATE/last" ] && [ "$(cat "$STATE/last")" = "$dump" ]; then return 0; fi
  ensure_repo
  # Dossier fixe : restic reconnait les fichiers d'une copie a l'autre.
  rm -rf /tmp/db && mkdir -p /tmp/db && cp "$dump" /tmp/db/savoire-db.sql.gz
  set -- /tmp/db /data
  [ -f /config/savoire.env ] && set -- "$@" /config
  restic backup --host savoire --tag savoire "$@"
  restic forget --host savoire --tag savoire --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
  if [ "$(date -u +%u)" = "7" ]; then
    restic check --read-data-subset=5%
    metric savoire_offsite_last_check_timestamp_seconds "$(date -u +%s)" "Derniere verification reussie du depot hors machine."
  fi
  echo "$dump" > "$STATE/last"
  metric savoire_offsite_last_success_timestamp_seconds "$(date -u +%s)" "Fin de la derniere copie hors machine reussie (secondes Unix)."
  echo "offsite : copie de $(basename "$dump") terminee"
}

if [ -z "${RESTIC_REPOSITORY:-}" ] || [ -z "${RESTIC_PASSWORD:-}" ]; then
  if [ "${1:-loop}" = "loop" ]; then
    while true; do
      echo "offsite : aucun depot configure (RESTIC_REPOSITORY, RESTIC_PASSWORD) : pas de copie hors machine" >&2
      sleep 3600
    done
  fi
  echo "offsite : aucun depot configure (RESTIC_REPOSITORY, RESTIC_PASSWORD)" >&2
  exit 1
fi

case "${1:-loop}" in
  now) copy force ;;
  snapshots) restic snapshots --host savoire ;;
  restore)
    target="${2:?dossier de destination}"
    mkdir -p "$target"
    restic restore latest --host savoire --tag savoire --target "$target"
    echo "offsite : restaure dans $target (tmp/db/savoire-db.sql.gz, data/, config/savoire.env)"
    ;;
  loop)
    while true; do
      copy || echo "offsite : copie en echec" >&2
      sleep 900
    done
    ;;
  *) echo "usage : offsite.sh [now|snapshots|restore <dir>]" >&2; exit 2 ;;
esac
