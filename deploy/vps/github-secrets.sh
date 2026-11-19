#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Envoie un .env dans l'environnement GitHub « production », d'ou la CI
# (.github/workflows/deploy.yml) refait le .env du serveur a chaque deploiement.
# A lancer sur votre poste, avec gh connecte (gh auth login) :
#
#   ENV_FILE=~/savoire-production.env bash deploy/vps/configure.sh
#   bash deploy/vps/github-secrets.sh ~/savoire-production.env [environnement]
#
# - Les mots de passe, cles, jetons et secrets deviennent des secrets GitHub
#   (illisibles une fois poses) ; le reste, des variables (lisibles, a
#   modifier dans GitHub : Settings > Environments > production).
# - GitHub refuse les noms qui commencent par GITHUB_ : GITHUB_CLIENT_ID
#   devient OAUTH_GITHUB_CLIENT_ID (la CI le renomme a l'envers).
# - Les valeurs vides sont ignorees. SAVOIRE_VERSION aussi : la CI la choisit.
# - Une cle SSH de deploiement est creee a cote du fichier (une fois) : la
#   privee part en secret DEPLOY_SSH_KEY, la publique est a donner a
#   install.sh --ci.
#
# Relance sans risque : chaque valeur est reecrite telle quelle. Gardez le
# fichier dans un gestionnaire de mots de passe : GitHub ne rend pas les
# secrets, et ZITADEL_MASTERKEY ou RESTIC_PASSWORD perdus = donnees perdues.
set -euo pipefail

file="${1:-}"
env_name="${2:-production}"
[ -f "$file" ] || { echo "Usage : $0 <fichier .env> [environnement]" >&2; exit 2; }
command -v gh >/dev/null || { echo "gh (GitHub CLI) est necessaire : https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh n'est pas connecte : gh auth login" >&2; exit 1; }

repo="${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
echo "Depot $repo, environnement $env_name"
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

deploy_key="$file.deploy-key"
if [ ! -f "$deploy_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -C savoire-ci -f "$deploy_key"
fi
gh secret set DEPLOY_SSH_KEY --repo "$repo" --env "$env_name" < "$deploy_key"

cat <<EOF

Cle de deploiement posee (secret DEPLOY_SSH_KEY). Sur le serveur :

  curl -fsSL https://raw.githubusercontent.com/$repo/master/deploy/vps/install.sh -o install.sh
  sudo DEPLOY_PUBKEY="$(cat "$deploy_key.pub")" bash install.sh --ci

Puis rangez $file dans votre gestionnaire de mots de passe et effacez-le,
avec $deploy_key et $deploy_key.pub.
EOF
