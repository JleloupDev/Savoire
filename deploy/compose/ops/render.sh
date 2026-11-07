#!/bin/sh
# Remplace ${VARIABLE} par sa valeur d'environnement dans un modele, puis
# lance la commande donnee. Prometheus et Alertmanager ne lisent pas les
# variables d'environnement dans leur configuration.
#   render.sh <modele> <sortie> -- <commande...>
set -eu
in="$1"; out="$2"; shift 2
[ "${1:-}" = "--" ] && shift
awk '{
  while (match($0, /\$\{[A-Z_][A-Z0-9_]*\}/)) {
    name = substr($0, RSTART + 2, RLENGTH - 3)
    $0 = substr($0, 1, RSTART - 1) ENVIRON[name] substr($0, RSTART + RLENGTH)
  }
  print
}' "$in" > "$out"
exec "$@"
