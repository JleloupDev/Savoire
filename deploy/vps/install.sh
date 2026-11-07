#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Installe Savoire sur un VPS neuf, de zero, en une commande (root) :
#
#   curl -fsSL https://raw.githubusercontent.com/JleloupDev/Savoire/master/deploy/vps/install.sh -o install.sh
#   sudo bash install.sh
#
# Debian 12 ou 13, Ubuntu 22.04 ou 24.04. Relance sans risque : chaque etape
# verifie ce qui est deja fait.
#
#  1. Systeme a jour, mises a jour de securite automatiques, fail2ban.
#  2. Pare-feu : SSH, 80 et 443 seulement.
#  3. Docker et Compose (depot officiel), journaux des conteneurs bornes.
#  4. Un utilisateur d'administration (ADMIN_USER), connexion SSH par cle
#     seulement, plus de connexion root.
#  5. Memoire d'echange si la machine n'en a pas.
#  6. Savoire dans SAVOIRE_DIR, configuration (configure.sh), demarrage.
#  7. Test de restauration chaque semaine (minuterie systemd).
#
# Options :
#   --restore    reinstaller depuis la copie hors machine (restore.sh) au
#                lieu de partir d'une configuration neuve
#   --no-start   tout preparer sans demarrer Savoire
# Variables : SAVOIRE_DIR (/opt/savoire), SAVOIRE_REPO, SAVOIRE_BRANCH (master),
# ADMIN_USER (savoire), SSH_PORT (22), SWAP_SIZE (2G), et celles de configure.sh.
set -euo pipefail

SAVOIRE_DIR="${SAVOIRE_DIR:-/opt/savoire}"
SAVOIRE_REPO="${SAVOIRE_REPO:-https://github.com/JleloupDev/Savoire.git}"
SAVOIRE_BRANCH="${SAVOIRE_BRANCH:-master}"
ADMIN_USER="${ADMIN_USER:-savoire}"
SSH_PORT="${SSH_PORT:-22}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
RESTORE=0
START=1
for arg in "$@"; do
  case "$arg" in
    --restore) RESTORE=1 ;;
    --no-start) START=0 ;;
    *) echo "option inconnue : $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }

[ "$(id -u)" = 0 ] || { echo "A lancer en root (sudo bash install.sh)." >&2; exit 1; }
. /etc/os-release
case "$ID" in
  debian|ubuntu) ;;
  *) echo "Systeme non prevu : $PRETTY_NAME (Debian ou Ubuntu attendus)." >&2; exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive

step "1. Systeme a jour"
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q ca-certificates curl git gnupg openssl ufw fail2ban unattended-upgrades jq
# Mises a jour de securite installees chaque nuit, sans redemarrage automatique.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now fail2ban >/dev/null

step "2. Pare-feu"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow "$SSH_PORT/tcp" comment ssh >/dev/null
ufw allow 80/tcp comment http >/dev/null
ufw allow 443/tcp comment https >/dev/null
ufw allow 443/udp comment http3 >/dev/null
ufw --force enable >/dev/null
# Docker publie ses ports sans passer par ufw : Savoire ne publie que 80 et
# 443, le reste sur 127.0.0.1 (Grafana, GlitchTip, Prometheus, Portainer).
ufw status | sed 's/^/   /'

step "3. Docker"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Journaux des conteneurs : 5 x 10 Mo par conteneur au plus (Loki en garde 30 jours).
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}
EOF
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null
docker --version

step "4. Utilisateur d'administration ($ADMIN_USER)"
if ! id "$ADMIN_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "Savoire" "$ADMIN_USER" >/dev/null
fi
usermod -aG sudo,docker "$ADMIN_USER"
home="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "$home/.ssh"
if [ -s /root/.ssh/authorized_keys ] && [ ! -s "$home/.ssh/authorized_keys" ]; then
  install -m 600 -o "$ADMIN_USER" -g "$ADMIN_USER" /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"
fi
# sudo sans mot de passe : le compte n'en a pas (connexion par cle seulement).
echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$ADMIN_USER"
chmod 440 "/etc/sudoers.d/90-$ADMIN_USER"
if [ -s "$home/.ssh/authorized_keys" ]; then
  cat > /etc/ssh/sshd_config.d/10-savoire.conf <<EOF
# Savoire (deploy/vps/install.sh) : cle SSH seulement, pas de root.
Port $SSH_PORT
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
  sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)
  warn "Connexion SSH : $ADMIN_USER@<serveur>, par cle seulement. Verifiez-la dans un AUTRE terminal avant de fermer celui-ci."
else
  warn "Aucune cle SSH pour $ADMIN_USER : connexion root et mot de passe laisses tels quels."
  warn "Ajoutez une cle dans $home/.ssh/authorized_keys puis relancez ce script."
fi

step "5. Memoire d'echange"
if [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/90-savoire.conf
sysctl -q --system
swapon --show

step "6. Savoire dans $SAVOIRE_DIR"
if [ -d "$SAVOIRE_DIR/.git" ]; then
  git -C "$SAVOIRE_DIR" fetch -q origin "$SAVOIRE_BRANCH"
  git -C "$SAVOIRE_DIR" checkout -q "$SAVOIRE_BRANCH"
  git -C "$SAVOIRE_DIR" pull -q --ff-only origin "$SAVOIRE_BRANCH"
else
  git clone -q --branch "$SAVOIRE_BRANCH" "$SAVOIRE_REPO" "$SAVOIRE_DIR"
fi
chown -R "$ADMIN_USER:$ADMIN_USER" "$SAVOIRE_DIR"
COMPOSE_DIR="$SAVOIRE_DIR/deploy/compose"

if [ "$RESTORE" = 1 ]; then
  bash "$SAVOIRE_DIR/deploy/vps/restore.sh"
else
  COMPOSE_DIR="$COMPOSE_DIR" bash "$SAVOIRE_DIR/deploy/vps/configure.sh"
fi
chown root:root "$COMPOSE_DIR/.env"
chmod 600 "$COMPOSE_DIR/.env"

step "7. Test de restauration hebdomadaire"
cat > /etc/systemd/system/savoire-restore-test.service <<EOF
[Unit]
Description=Savoire : test de restauration de la copie hors machine
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=SAVOIRE_DIR=$SAVOIRE_DIR
ExecStart=/usr/bin/env bash $SAVOIRE_DIR/deploy/vps/restore-test.sh
EOF
cat > /etc/systemd/system/savoire-restore-test.timer <<'EOF'
[Unit]
Description=Savoire : test de restauration chaque dimanche

[Timer]
OnCalendar=Sun *-*-* 05:00:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now savoire-restore-test.timer >/dev/null

if [ "$START" = 1 ] && [ "$RESTORE" = 0 ]; then
  step "Demarrage"
  cd "$COMPOSE_DIR"
  docker compose pull -q
  docker compose up -d
  docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
fi

domain="$(grep -E '^SAVOIRE_DOMAIN=' "$COMPOSE_DIR/.env" | cut -d= -f2-)"
auth="$(grep -E '^AUTH_DOMAIN=' "$COMPOSE_DIR/.env" | cut -d= -f2-)"
cat <<EOF

Savoire est installe.

  Appli      : https://$domain
  Connexion  : https://$auth/ui/console

Depuis votre poste (tunnel SSH, rien n'est expose sur Internet) :
  ssh -L 3000:127.0.0.1:3000 -L 8100:127.0.0.1:8100 -L 9443:127.0.0.1:9443 $ADMIN_USER@<serveur>
  Grafana    : http://localhost:3000   (admin, GRAFANA_ADMIN_PASSWORD)
  GlitchTip  : http://localhost:8100   (ADMIN_EMAIL, GLITCHTIP_ADMIN_PASSWORD)
  Portainer  : https://localhost:9443  (compte a creer dans les 5 minutes)

Les mots de passe sont dans $COMPOSE_DIR/.env (root seulement).
Verifier : sudo bash $SAVOIRE_DIR/deploy/vps/check.sh
EOF
