# Savoire Store

Le catalogue des **plugins**, **modèles de notes**, **modules** et **paquets de notes** de
[Savoire](../Savoire). Un site (rendu serveur, sans script, référençable) et
une API.

- Le site : accueil (recherche, sélections, catégories), catalogue avec
  filtres (sorte, catégorie, prix, note, tri), pages des catégories, fiche de
  chaque élément (captures d'écran, description en Markdown, droits,
  versions, avis), page « Publier », `sitemap.xml`.
- Comptes : ceux de Savoire (Zitadel). Tout compte peut laisser un avis,
  depuis l'application ou depuis le site (connexion OIDC, cookie du site).
- Publication comme Obsidian : une release GitHub du dépôt de l'éditeur
  (voir [docs/publier.md](docs/publier.md)).
- Contrôles automatiques à chaque version ; relecture humaine de la première
  version d'un élément et de toute version qui lève un avertissement.
- Paquets signés (ECDSA P-256) : l'application vérifie avant d'installer.
- Plugins payants : prévus dans le modèle (prix), l'achat viendra plus tard.

## Lancer en développement

Il faut le PostgreSQL et le Zitadel de développement de Savoire
(`deploy/compose/docker-compose.dev.yml` dans Savoire).

```bash
docker exec savoire-dev-postgres-1 psql -U postgres -c "CREATE DATABASE savoire_store OWNER savoire"
AUD=$(python3 -c "import json;print(json.load(open('../Savoire/.local/zitadel/savoire-oidc.json'))['Auth']['Oidc']['Audience'])")
ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS=http://127.0.0.1:5100 Auth__Audience=$AUD \
  dotnet run --project src/SavoireStore.Api --no-launch-profile
```

- Site : http://127.0.0.1:5100/
- Les migrations s'appliquent au démarrage.
- Un catalogue de démonstration (18 éléments fictifs, avec des avis et les
  captures de `docs/captures`) : ajouter
  `Store__DemoSeed=true Store__DemoImages=$PWD/../docs/captures/captures`.
  Développement seulement ; une base à part est plus propre
  (`ConnectionStrings__Store=...Database=savoire_store_demo...`).
- Connexion au site : `Auth__ClientId` (l'appli web de Savoire, `WebClientId`
  du même fichier) ; l'adresse de retour `http://127.0.0.1:5100/auth/callback`
  est déclarée par `zitadel-bootstrap` (`STORE_ORIGINS`).
- En développement, une clé de signature est créée dans `src/SavoireStore.Api/.local/`.
- Administrateurs : `Store:AdminEmails` (adresse vérifiée) ou `Store:AdminSubjects`.

Tests : `dotnet test` (une base PostgreSQL neuve par classe ;
`SAVOIRE_TEST_POSTGRES` pour un autre serveur).

## Réglages

| Clé | Rôle |
|---|---|
| `ConnectionStrings:Store` | Base PostgreSQL. |
| `Auth:Authority`, `Auth:Audience` | Zitadel de Savoire, et l'id du projet Savoire. |
| `Auth:ClientId` | Facultatif : l'appli web de Savoire, pour se connecter au site. Sans elle, les avis se donnent depuis l'application. |
| `Store:AppUrl` | Facultatif : l'adresse de l'application (bouton « Ouvrir Savoire » des fiches). |
| `Store:SigningKeyFile` | Clé privée de signature (PEM). Obligatoire hors développement : la perdre invalide toutes les signatures. |
| `Store:AdminEmails`, `Store:AdminSubjects` | Qui relit les publications. |
| `Store:GitHubToken` | Facultatif : jeton GitHub, pour une limite d'appels plus haute. |

## API

| Route | Rôle |
|---|---|
| `GET /api/v1/items?q&kind&category&price&minRating&sort&page&pageSize` | Catalogue (`sort` : popular, recent, rating, name ; `price` : free, paid). |
| `GET /api/v1/facets?q&kind&category&price&minRating` | Comptes par sorte, catégorie et prix (filtres). |
| `GET /api/v1/categories` | Les catégories, avec leur nom et leur nombre d'éléments. |
| `GET /api/v1/items/{id}` | Un élément, ses droits, ses versions, ses captures (`screenshots`). |
| `GET /media/{id}` | Une image (icône `iconId`, capture), en cache pour toujours. |
| `GET /api/v1/items/{id}/download?version=` | Le paquet (JSON, gzip si demandé), signature dans `X-Savoire-Signature`. |
| `GET /api/v1/signing-key` | Clé publique du store (SPKI, base64). |
| `GET/POST /api/v1/items/{id}/reviews` | Avis et répartition des notes (POST : compte, `{ rating, text }`). |
| `DELETE /api/v1/items/{id}/reviews/{rid}`, `POST …/{rid}/reply` | Retirer son avis ; réponse de l'éditeur. |
| `POST /api/v1/publish` | `{ repo }` : publier la dernière release GitHub. |
| `GET /api/v1/me/items` | Mes éléments, versions et contrôles. |
| `GET /api/v1/admin/queue`, `POST /api/v1/admin/versions/{id}/approve|reject`, `POST /api/v1/admin/items/{id}/remove` | Relecture. |

Erreurs : `{ error: { code, message } }`.

## Licence

AGPL-3.0-or-later, comme Savoire.
