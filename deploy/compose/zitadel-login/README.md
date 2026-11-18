# Page de connexion de Savoire

La page de connexion de Zitadel (login v2, licence MIT), retouchée pour
entrer sans mot de passe : un fournisseur, un lien reçu par mail, ou une clé
d'accès. Pourquoi et comment : [ADR-031](../../../docs/Architecture/ADR/ADR-031-connexion-sans-mot-de-passe.md).

| Fichier | Rôle |
|---|---|
| `Dockerfile` | Prend les sources à `ZITADEL_VERSION`, applique le patch, construit l'image |
| `patches/0001-savoire-sans-mot-de-passe.patch` | Les retouches (dans `apps/login/src`) |
| `locales/fr.json`, `locales/en.json` | Nos textes, fusionnés dans ceux de Zitadel |
| `merge-locales.mjs` | La fusion des textes |

Le cœur des retouches est `src/lib/server/savoire.ts` (dans le patch).

## Construire

```bash
docker build -t savoire-login:local deploy/compose/zitadel-login
```

Le compose de dev la construit seul (`docker compose ... up -d --build zitadel-login`).
La CI publie `ghcr.io/<propriétaire>/savoire-login` avec les autres images.

## Modifier le patch, ou monter de version

`ZITADEL_VERSION` suit l'image de Zitadel (`docker-compose*.yml`,
`docker-compose.build.yml`, `Dockerfile`).

```bash
git clone --depth 1 --branch v4.16.0 --filter=blob:none --sparse \
  https://github.com/zitadel/zitadel.git zitadel && cd zitadel
git sparse-checkout set apps/login packages proto
git apply --3way ../Savoire/deploy/compose/zitadel-login/patches/*.patch
# ... modifier apps/login/src, essayer :
pnpm install --frozen-lockfile --filter "@zitadel/login..." --filter "."
(cd packages/zitadel-proto && pnpm exec buf generate ../../proto)
(cd packages/zitadel-client && pnpm run build)
(cd apps/login && pnpm exec tsc --noEmit -p . && pnpm run build)
# puis regenerer le patch (les fichiers nouveaux compris) :
git add -N apps/login/src && git diff -- apps/login/src \
  > ../Savoire/deploy/compose/zitadel-login/patches/0001-savoire-sans-mot-de-passe.patch
```

Lors d'une montée de version, `--3way` signale les conflits à résoudre.

## Essayer

Avec le compose de dev lancé, tout se lit dans Mailpit (`http://localhost:8025`) :

1. Ouvrir l'appli, « Se connecter », puis « Créer un compte ».
2. Ouvrir le lien du mail, recopier le code dans la première fenêtre.
3. « Plus tard » ou « Continuer » (clé d'accès) : retour dans l'appli.
4. Se reconnecter avec la même adresse : lien par mail, ou clé d'accès.
