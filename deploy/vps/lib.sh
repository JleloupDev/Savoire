# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Commun aux scripts de deploy/vps (source, pas lance seul).
#
# Savoire tourne sous un compte a lui (savoire, sans sudo), avec son propre
# Docker (Docker rootless) : rien ne tourne en root. Ce compte possede le
# dossier de Savoire ; les scripts lances en root (sudo) se relancent sous lui.

# as_owner <script> [args...] : en root, relance le script sous le compte qui
# possede le dossier de Savoire (si ce n'est pas root). Sinon, ne fait rien.
as_owner() {
  local script="$1"; shift
  [ "$(id -u)" = 0 ] || return 0
  local owner
  owner="$(stat -c %U "$SAVOIRE_DIR")"
  [ "$owner" != root ] || return 0
  exec sudo -u "$owner" -H SAVOIRE_DIR="$SAVOIRE_DIR" bash "$script" "$@"
}

# Le Docker du compte courant : son socket, ses donnees. En root (ancienne
# installation, Docker classique), rien ne change.
if [ "$(id -u)" != 0 ]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DOCKER_HOST="${DOCKER_HOST:-unix://$XDG_RUNTIME_DIR/docker.sock}"
  # Lus par docker-compose*.yml (Portainer, Alloy, cAdvisor).
  export DOCKER_SOCKET="${DOCKER_SOCKET:-$XDG_RUNTIME_DIR/docker.sock}"
  export DOCKER_DATA_ROOT="${DOCKER_DATA_ROOT:-$HOME/.local/share/docker}"
fi
