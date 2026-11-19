#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Envoie un .env dans l'environnement GitHub « production », d'ou la CI
# (.github/workflows/deploy.yml) refait le .env du serveur a chaque deploiement.
# Avec --server, installe aussi le serveur et lance le premier deploiement.
# A lancer sur votre poste, dans le depot, avec gh connecte (gh auth login) :
#
#   ENV_FILE=~/savoire-production.env bash deploy/vps/configure.sh
#   bash deploy/vps/github-secrets.sh ~/savoire-production.env --server ubuntu@<IP>
#
# Options :
#   --server <compte>@<machine>  votre compte sudo sur le serveur (ubuntu chez
#                                Oracle), joint par votre propre cle SSH
#   --port <n>                   port SSH du serveur (22)
#   --env <nom>                  environnement GitHub (production)
#
# Ce qu'il fait :
#  1. Les mots de passe, cles, jetons et secrets deviennent des secrets GitHub
#     (illisibles une fois poses) ; le reste, des variables (lisibles, a
#     modifier dans GitHub : Settings > Environments > production). GitHub
#     refuse les noms en GITHUB_ : GITHUB_CLIENT_ID devient
#     OAUTH_GITHUB_CLIENT_ID (la CI le renomme a l'envers). Les valeurs vides
#     et SAVOIRE_VERSION (choisie par la CI) sont ignorees.
#  2. Une cle SSH de deploiement, creee a cote du fichier (une fois) : la
#     privee part en secret DEPLOY_SSH_KEY.
#  Avec --server :
#  3. install.sh --ci sur le serveur (la cle publique de la CI posee sur le
#     compte savoire), par votre connexion SSH.
#  4. DEPLOY_HOST, DEPLOY_HOST_KEY (lue par cette meme connexion : la CI ne
#     parlera qu'a ce serveur), DEPLOY_PORT au besoin.
#  5. Redemarrage si le pare-feu d'origine de l'hebergeur bloque encore 80/443.
#  6. Premier deploiement (Actions > Deploy), suivi jusqu'au bout.
#
# Relance sans risque. Gardez le fichier .env dans un gestionnaire de mots de
# passe : GitHub ne rend pas les secrets, et ZITADEL_MASTERKEY ou
# RESTIC_PASSWORD perdus = donnees perdues.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
file=""; env_name="production"; server=""; port=22
while [ $# -gt 0 ]; do
  case "$1" in
    --server) server="${2:?--server <compte>@<machine>}"; shift 2 ;;
    --port) port="${2:?--port <n>}"; shift 2 ;;
    --env) env_name="${2:?--env <nom>}"; shift 2 ;;
    -*) echo "option inconnue : $1" >&2; exit 2 ;;
    *) if [ -z "$file" ]; then file="$1"; else env_name="$1"; fi; shift ;;
  esac
done
[ -f "$file" ] || { echo "Usage : $0 <fichier .env> [--server ubuntu@<IP>] [--port 22] [--env production]" >&2; exit 2; }
if [ -n "$server" ]; then
  [[ "$server" == *@* ]] || { echo "--server : <compte>@<machine> attendu (ubuntu@1.2.3.4)." >&2; exit 2; }
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "--port : un nombre." >&2; exit 2; }
fi
command -v gh >/dev/null || { echo "gh (GitHub CLI) est necessaire : https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh n'est pas connecte : gh auth login" >&2; exit 1; }

step() { printf '\n\033[1;32m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
env_get() { grep -E "^$1=" "$file" | tail -1 | cut -d= -f2- || true; }

repo="${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"

step "1. Secrets et variables : $repo, environnement $env_name"
gh api -X PUT "repos/$repo/environments/$env_name" >/dev/null
secrets=0; vars=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  key="${line%%=*}"; value="${line#*=}"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
  [ -n "$value" ] || continue
  [ "$key" != SAVOIRE_VERSION ] || continue
  name="$key"
  [[ "$name" == GITHUB_* ]] && name="OAUTH_$name"
  if [[ "$key" =~ (PASSWORD|SECRET|MASTERKEY|TOKEN|_KEY$) ]]; then
    printf '%s' "$value" | gh secret set "$name" --repo "$repo" --env "$env_name"
    secrets=$((secrets + 1))
  else
    gh variable set "$name" --repo "$repo" --env "$env_name" --body "$value" >/dev/null
    vars=$((vars + 1))
  fi
done < "$file"
echo "$secrets secrets, $vars variables."

step "2. Cle de deploiement"
deploy_key="$file.deploy-key"
[ -f "$deploy_key" ] || ssh-keygen -q -t ed25519 -N '' -C savoire-ci -f "$deploy_key"
gh secret set DEPLOY_SSH_KEY --repo "$repo" --env "$env_name" < "$deploy_key"
pubkey="$(cat "$deploy_key.pub")"
echo "Secret DEPLOY_SSH_KEY pose."

if [ -z "$server" ]; then
  cat <<EOF

Sur le serveur, depuis votre compte sudo :

  curl -fsSL https://raw.githubusercontent.com/$repo/master/deploy/vps/install.sh -o install.sh
  sudo DEPLOY_PUBKEY="$pubkey" bash install.sh --ci

Ou relancez ce script avec --server ubuntu@<IP> : il le fait pour vous.
EOF
  exit 0
fi

host="${server#*@}"
ssh_srv() { ssh -p "$port" -o ServerAliveInterval=30 "$server" "$@"; }

# Le DNS doit deja pointer vers le serveur : sinon pas de certificat, et le
# premier deploiement echoue a l'attente du site.
for d in "$(env_get SAVOIRE_DOMAIN)" "$(env_get AUTH_DOMAIN)"; do
  [ -n "$d" ] || continue
  ip="$(getent ahostsv4 "$d" 2>/dev/null | awk 'NR==1 {print $1}')"
  if [ -z "$ip" ]; then
    warn "$d ne pointe nulle part (DNS) : le certificat HTTPS ne pourra pas se faire."
  elif [[ "$host" =~ ^[0-9.]+$ ]] && [ "$ip" != "$host" ]; then
    warn "$d pointe vers $ip, pas vers $host."
  fi
done

step "3. Installation du serveur ($server)"
# Le install.sh de ce depot, envoye par la connexion SSH.
ssh_srv 'cat > /tmp/savoire-install.sh' < "$HERE/install.sh"
ssh -t -p "$port" -o ServerAliveInterval=30 "$server" \
  "sudo DEPLOY_PUBKEY='$pubkey' SSH_PORT='$port' bash /tmp/savoire-install.sh --ci && rm -f /tmp/savoire-install.sh"

step "4. Serveur declare dans GitHub"
hostkey="$(ssh_srv 'cat /etc/ssh/ssh_host_ed25519_key.pub' | awk '{print $1, $2}')"
[[ "$hostkey" == ssh-ed25519\ * ]] || { echo "Cle du serveur illisible : $hostkey" >&2; exit 1; }
gh variable set DEPLOY_HOST --repo "$repo" --env "$env_name" --body "$host" >/dev/null
gh variable set DEPLOY_HOST_KEY --repo "$repo" --env "$env_name" --body "$hostkey" >/dev/null
if [ "$port" != 22 ]; then
  gh variable set DEPLOY_PORT --repo "$repo" --env "$env_name" --body "$port" >/dev/null
fi
echo "DEPLOY_HOST=$host, DEPLOY_HOST_KEY=$hostkey"

step "5. Pare-feu d'origine"
# Oracle livre une regle REJECT qui ferme 80 et 443 ; ufw la remplace, mais
# elle reste active jusqu'au redemarrage.
if ssh_srv "sudo iptables -S INPUT" | grep -q -- '-j REJECT --reject-with icmp-host-prohibited'; then
  echo "Regle d'origine encore active : redemarrage."
  ssh_srv 'sudo systemctl reboot' || true
  sleep 20
  for _ in $(seq 1 60); do
    ssh -p "$port" -o ConnectTimeout=5 -o BatchMode=yes "$server" true 2>/dev/null && break
    sleep 5
  done
  ssh -p "$port" -o ConnectTimeout=5 -o BatchMode=yes "$server" true \
    || { echo "Le serveur ne repond pas apres 5 minutes." >&2; exit 1; }
  echo "Serveur de retour."
else
  echo "Rien a faire."
fi

step "6. Premier deploiement"
# Le dernier commit de master dont les images sont construites (images.yml).
sha="$(gh run list --repo "$repo" --workflow images.yml --branch master --status success --limit 1 \
  --json headSha -q '.[0].headSha // empty')"
[ -n "$sha" ] || { echo "Aucune image construite sur master (Actions > Images)." >&2; exit 1; }
echo "Commit ${sha:0:7}"
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run deploy.yml --repo "$repo" --ref master -f ref="$sha"
run=""
for _ in $(seq 1 30); do
  run="$(gh run list --repo "$repo" --workflow deploy.yml --event workflow_dispatch --limit 5 \
    --json databaseId,createdAt -q "map(select(.createdAt >= \"$since\")) | .[0].databaseId // empty")"
  [ -n "$run" ] && break
  sleep 2
done
[ -n "$run" ] || { echo "Deploiement lance, suivi impossible : voir Actions > Deploy." >&2; exit 1; }
gh run watch "$run" --repo "$repo" --exit-status

cat <<EOF

Savoire est deploye : https://$(env_get SAVOIRE_DOMAIN)
Ensuite, chaque image construite sur master est deployee toute seule.

A faire maintenant : ranger $file dans votre gestionnaire de mots de passe,
puis l'effacer avec $deploy_key et $deploy_key.pub.
EOF
