#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Installe Savoire sur un VPS neuf, de zero, en une commande, depuis votre
# compte d'administration (celui qui a sudo, « ubuntu » chez Oracle) :
#
#   curl -fsSL https://raw.githubusercontent.com/JleloupDev/Savoire/master/deploy/vps/install.sh -o install.sh
#   sudo bash install.sh
#
# Debian 12 ou 13, Ubuntu 22.04 ou 24.04. Relance sans risque : chaque etape
# verifie ce qui est deja fait.
#
# Deux comptes :
#   - le votre (ADMIN_USER, par defaut celui qui lance sudo) : sudo, SSH par
#     cle seulement. C'est le seul a pouvoir devenir root.
#   - savoire (SERVICE_USER) : sans sudo, sans mot de passe. Il possede
#     Savoire (SAVOIRE_DIR, le .env, les sauvegardes) et fait tourner son
#     propre Docker (Docker rootless) : aucun conteneur ne tourne en root.
#     Pour agir sous ce compte : sudo -iu savoire
#
#  1. Systeme a jour, mises a jour de securite automatiques, fail2ban.
#  2. Pare-feu : SSH, 80 et 443 seulement.
#  3. Docker rootless (depot officiel) ; le Docker root est arrete.
#  4. Les deux comptes, connexion SSH par cle seulement, plus de root.
#  5. Memoire d'echange si la machine n'en a pas.
#  6. Savoire dans SAVOIRE_DIR, configuration (configure.sh), demarrage.
#  7. Test de restauration chaque semaine (minuterie systemd, sous savoire).
#
# Options :
#   --restore    reinstaller depuis la copie hors machine (restore.sh) au
#                lieu de partir d'une configuration neuve
#   --no-start   tout preparer sans demarrer Savoire
#   --ci         la machine seulement : la configuration (.env) et le
#                demarrage viennent de la CI (.github/workflows/deploy.yml).
#                DEPLOY_PUBKEY : la cle publique SSH de la CI, posee sur le
#                compte savoire et limitee a deploy/vps/ci-deploy.sh.
# Variables : SAVOIRE_DIR (/opt/savoire), SAVOIRE_REPO, SAVOIRE_BRANCH (master),
# ADMIN_USER (celui qui lance sudo), SERVICE_USER (savoire), SSH_PORT (22),
# SWAP_SIZE (2G), et celles de configure.sh.
set -euo pipefail

SAVOIRE_DIR="${SAVOIRE_DIR:-/opt/savoire}"
SAVOIRE_REPO="${SAVOIRE_REPO:-https://github.com/JleloupDev/Savoire.git}"
SAVOIRE_BRANCH="${SAVOIRE_BRANCH:-master}"
ADMIN_USER="${ADMIN_USER:-${SUDO_USER:-}}"
SERVICE_USER="${SERVICE_USER:-savoire}"
SSH_PORT="${SSH_PORT:-22}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
RESTORE=0
START=1
CI=0
DEPLOY_PUBKEY="${DEPLOY_PUBKEY:-}"
for arg in "$@"; do
  case "$arg" in
    --restore) RESTORE=1 ;;
    --no-start) START=0 ;;
    --ci) CI=1; START=0 ;;
    *) echo "option inconnue : $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
die() { echo "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "A lancer avec sudo depuis votre compte (sudo bash install.sh)."
[ -n "$ADMIN_USER" ] && [ "$ADMIN_USER" != root ] \
  || die "Lancez-le avec sudo depuis votre compte (ubuntu chez Oracle), ou donnez ADMIN_USER."
id "$ADMIN_USER" >/dev/null 2>&1 || die "Le compte $ADMIN_USER n'existe pas."
[ "$ADMIN_USER" != "$SERVICE_USER" ] || die "ADMIN_USER et SERVICE_USER doivent etre deux comptes differents."
if [ "$CI" = 1 ]; then
  [ "$RESTORE" = 0 ] || die "--ci et --restore ne vont pas ensemble."
  [[ "$DEPLOY_PUBKEY" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+ ]] \
    || die "--ci : DEPLOY_PUBKEY attendu (cle publique SSH de la CI, ssh-ed25519 ...)."
fi
. /etc/os-release
case "$ID" in
  debian|ubuntu) ;;
  *) die "Systeme non prevu : $PRETTY_NAME (Debian ou Ubuntu attendus)." ;;
esac
export DEBIAN_FRONTEND=noninteractive
# Le compte savoire ne peut pas entrer dans le dossier courant de root.
cd /

step "1. Systeme a jour"
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q ca-certificates curl git gnupg openssl ufw fail2ban unattended-upgrades jq \
  uidmap dbus-user-session slirp4netns
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
# Savoire ne publie que 80 et 443, le reste sur 127.0.0.1 (Grafana,
# GlitchTip, Prometheus, Portainer).
ufw status | sed 's/^/   /'

step "3. Docker (rootless)"
if ! command -v dockerd-rootless-setuptool.sh >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
    docker-compose-plugin docker-ce-rootless-extras
fi
# Le Docker root ne sert pas : chaque conteneur tourne sous le compte savoire.
systemctl disable --now docker.service docker.socket >/dev/null 2>&1 || true
rm -f /var/run/docker.sock
# Ubuntu 24.04 restreint les espaces de noms des utilisateurs (AppArmor) :
# rootlesskit, qui lance le Docker du compte, y a droit.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  cat > /etc/apparmor.d/usr.bin.rootlesskit <<'EOF'
# Savoire (deploy/vps/install.sh) : Docker rootless.
abi <abi/4.0>,
include <tunables/global>

/usr/bin/rootlesskit flags=(unconfined) {
  userns,

  include if exists <local/usr.bin.rootlesskit>
}
EOF
  apparmor_parser -r /etc/apparmor.d/usr.bin.rootlesskit
fi
# 80 et 443 sans root (Caddy), et memoire d'echange peu utilisee.
cat > /etc/sysctl.d/90-savoire.conf <<'EOF'
net.ipv4.ip_unprivileged_port_start=80
vm.swappiness=10
EOF
sysctl -q --system
docker --version

step "4. Comptes"
# ── Votre compte : sudo, SSH par cle ──
admin_home="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
if [ -s "$admin_home/.ssh/authorized_keys" ]; then
  cat > /etc/ssh/sshd_config.d/10-savoire.conf <<EOF
# Savoire (deploy/vps/install.sh) : cle SSH seulement, pas de root.
Port $SSH_PORT
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
  sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)
  echo "Administration : $ADMIN_USER@<serveur>, par cle seulement."
else
  warn "Aucune cle SSH pour $ADMIN_USER : connexion root et mot de passe laisses tels quels."
  warn "Ajoutez une cle dans $admin_home/.ssh/authorized_keys puis relancez ce script."
fi

# ── Le compte de Savoire : sans sudo, son propre Docker ──
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "Savoire" "$SERVICE_USER" >/dev/null
fi
# Ni sudo ni groupe docker (anciennes installations).
gpasswd -d "$SERVICE_USER" sudo >/dev/null 2>&1 || true
gpasswd -d "$SERVICE_USER" docker >/dev/null 2>&1 || true
rm -f "/etc/sudoers.d/90-$SERVICE_USER"
passwd -l "$SERVICE_USER" >/dev/null
svc_uid="$(id -u "$SERVICE_USER")"
svc_home="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
# Plages d'identifiants des conteneurs (adduser les donne d'ordinaire).
grep -q "^$SERVICE_USER:" /etc/subuid || usermod --add-subuids 231072-296607 "$SERVICE_USER"
grep -q "^$SERVICE_USER:" /etc/subgid || usermod --add-subgids 231072-296607 "$SERVICE_USER"
# Sa session systemd tourne sans connexion : Docker et Savoire demarrent avec
# la machine.
loginctl enable-linger "$SERVICE_USER"
for _ in $(seq 1 30); do [ -S "/run/user/$svc_uid/bus" ] && break; sleep 1; done
[ -S "/run/user/$svc_uid/bus" ] || die "La session systemd de $SERVICE_USER n'a pas demarre."

as_svc() {
  sudo -u "$SERVICE_USER" -H \
    XDG_RUNTIME_DIR="/run/user/$svc_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$svc_uid/bus" \
    DOCKER_HOST="unix:///run/user/$svc_uid/docker.sock" \
    DOCKER_SOCKET="/run/user/$svc_uid/docker.sock" \
    DOCKER_DATA_ROOT="$svc_home/.local/share/docker" \
    "$@"
}

if [ ! -f "$svc_home/.config/systemd/user/docker.service" ]; then
  as_svc dockerd-rootless-setuptool.sh install >/dev/null
fi
# slirp4netns : Caddy voit la vraie adresse des visiteurs (journaux, limites).
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$svc_home/.config/systemd/user/docker.service.d" "$svc_home/.config/docker"
cat > "$svc_home/.config/systemd/user/docker.service.d/10-savoire.conf" <<'EOF'
[Service]
Environment="DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns"
Environment="DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns"
EOF
# Journaux des conteneurs : 5 x 10 Mo par conteneur au plus (Loki en garde 30 jours).
cat > "$svc_home/.config/docker/daemon.json" <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
EOF
chown -R "$SERVICE_USER:$SERVICE_USER" "$svc_home/.config"
as_svc systemctl --user daemon-reload
as_svc systemctl --user enable docker >/dev/null 2>&1
as_svc systemctl --user restart docker
for _ in $(seq 1 30); do as_svc docker info >/dev/null 2>&1 && break; sleep 1; done
as_svc docker info --format 'Docker {{.ServerVersion}} sous {{.ClientInfo.Context}} ({{.SecurityOptions}})' \
  || die "Le Docker de $SERVICE_USER ne repond pas : journalctl --user -u docker (sous $SERVICE_USER)."

# Un shell sous ce compte (sudo -iu savoire) trouve son Docker.
if ! grep -q 'deploy/vps/lib.sh' "$svc_home/.bashrc" 2>/dev/null; then
  cat >> "$svc_home/.bashrc" <<EOF

# Savoire : le Docker de ce compte (rootless).
[ -f $SAVOIRE_DIR/deploy/vps/lib.sh ] && SAVOIRE_DIR=$SAVOIRE_DIR . $SAVOIRE_DIR/deploy/vps/lib.sh
cd $SAVOIRE_DIR/deploy/compose 2>/dev/null || true
EOF
fi

# Connexion SSH : la cle de la CI seulement, limitee a ci-deploy.sh, sans
# terminal ni tunnel. La demande de la CI passe en argument du script.
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$svc_home/.ssh"
if [ "$CI" = 1 ]; then
  key="$(printf '%s' "$DEPLOY_PUBKEY" | awk '{print $1, $2}')"
  forced="bash $SAVOIRE_DIR/deploy/vps/ci-deploy.sh \\\"\$SSH_ORIGINAL_COMMAND\\\""
  printf 'command="%s",restrict %s savoire-ci\n' "$forced" "$key" > "$svc_home/.ssh/authorized_keys"
  chown "$SERVICE_USER:$SERVICE_USER" "$svc_home/.ssh/authorized_keys"
  chmod 600 "$svc_home/.ssh/authorized_keys"
  echo "Cle de la CI posee sur $SERVICE_USER (ci-deploy.sh seulement)."
fi

step "5. Memoire d'echange"
if [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon --show

step "6. Savoire dans $SAVOIRE_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$SAVOIRE_DIR"
if [ -d "$SAVOIRE_DIR/.git" ]; then
  chown -R "$SERVICE_USER:$SERVICE_USER" "$SAVOIRE_DIR"
  if [ "$CI" = 0 ]; then
    as_svc git -C "$SAVOIRE_DIR" fetch -q origin "$SAVOIRE_BRANCH"
    as_svc git -C "$SAVOIRE_DIR" checkout -q "$SAVOIRE_BRANCH"
    as_svc git -C "$SAVOIRE_DIR" pull -q --ff-only origin "$SAVOIRE_BRANCH"
  fi
else
  as_svc git clone -q --branch "$SAVOIRE_BRANCH" "$SAVOIRE_REPO" "$SAVOIRE_DIR"
fi
COMPOSE_DIR="$SAVOIRE_DIR/deploy/compose"

if [ "$RESTORE" = 1 ]; then
  as_svc bash "$SAVOIRE_DIR/deploy/vps/restore.sh"
elif [ "$CI" = 0 ]; then
  as_svc env COMPOSE_DIR="$COMPOSE_DIR" bash "$SAVOIRE_DIR/deploy/vps/configure.sh"
fi
if [ -f "$COMPOSE_DIR/.env" ]; then
  chown "$SERVICE_USER:$SERVICE_USER" "$COMPOSE_DIR/.env"
  chmod 600 "$COMPOSE_DIR/.env"
fi

step "7. Test de restauration hebdomadaire"
cat > /etc/systemd/system/savoire-restore-test.service <<EOF
[Unit]
Description=Savoire : test de restauration de la copie hors machine
After=user@$svc_uid.service
Requires=user@$svc_uid.service

[Service]
Type=oneshot
User=$SERVICE_USER
Environment=SAVOIRE_DIR=$SAVOIRE_DIR
Environment=XDG_RUNTIME_DIR=/run/user/$svc_uid
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
  as_svc bash -c "cd '$COMPOSE_DIR' && docker compose pull -q && docker compose up -d \
    && docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'"
fi

if [ "$CI" = 1 ]; then
  hostkey="$(awk '{print $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub)"
  cat <<EOF

La machine est prete. Savoire sera installe par la CI.

1. Redemarrer une fois (sudo reboot) : le pare-feu d'origine de l'hebergeur
   (Oracle notamment) reste actif jusque-la et bloque 80 et 443.
2. Dans GitHub, environnement « production », deux variables :
     gh variable set DEPLOY_HOST --env production --body "<IP publique de cette machine>"
     gh variable set DEPLOY_HOST_KEY --env production --body "$hostkey"
EOF
  [ "$SSH_PORT" = 22 ] || echo "     gh variable set DEPLOY_PORT --env production --body \"$SSH_PORT\""
  cat <<EOF
3. Actions > Deploy > Run workflow : premier deploiement. Ensuite, chaque
   image construite sur master est deployee toute seule.

Pour agir sous le compte de Savoire : sudo -iu $SERVICE_USER
EOF
  exit 0
fi

domain="$(grep -E '^SAVOIRE_DOMAIN=' "$COMPOSE_DIR/.env" | cut -d= -f2-)"
auth="$(grep -E '^AUTH_DOMAIN=' "$COMPOSE_DIR/.env" | cut -d= -f2-)"
cat <<EOF

Savoire est installe, sous le compte $SERVICE_USER (sans sudo, Docker rootless).

  Appli      : https://$domain
  Connexion  : https://$auth/ui/console

Depuis votre poste (tunnel SSH, rien n'est expose sur Internet) :
  ssh -L 3000:127.0.0.1:3000 -L 8100:127.0.0.1:8100 -L 9443:127.0.0.1:9443 $ADMIN_USER@<serveur>
  Grafana    : http://localhost:3000   (admin, GRAFANA_ADMIN_PASSWORD)
  GlitchTip  : http://localhost:8100   (ADMIN_EMAIL, GLITCHTIP_ADMIN_PASSWORD)
  Portainer  : https://localhost:9443  (compte a creer dans les 5 minutes)

Les mots de passe sont dans $COMPOSE_DIR/.env (compte $SERVICE_USER seulement).
Agir sous ce compte : sudo -iu $SERVICE_USER
Verifier : sudo bash $SAVOIRE_DIR/deploy/vps/check.sh
EOF
