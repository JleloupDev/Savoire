# Pair indexeur : contrat technique

Décision : ADR-027. Ce document fixe les échanges entre les clients, le backend et le pair indexeur (« Savoire Indexer »). Les trois côtés le suivent ; un changement ici se fait d'abord ici.

## Topologie

```
client ──HTTPS──▶ backend (public)  ──HTTP privé──▶ instances du pair indexeur
                    ▲                                   │
                    └──────── API interne ◀─────────────┘
```

- Le client ne parle qu'au backend. Le backend authentifie, vérifie les droits sur le vault, limite le débit, puis relaie au pair qui possède le vault.
- Le pair n'est jamais exposé. Il lit les vaults par l'API interne du backend.
- Les deux sens utilisent le même **jeton de service** (`Indexer:ServiceToken` côté backend, `SAVOIRE_INDEXER_TOKEN` côté pair), en `Authorization: Bearer`. Sans jeton configuré, l'API interne n'existe pas et les routes publiques répondent 503.

## Répartition des vaults entre instances

- Liste des instances dans la configuration du backend : `Indexer:Instances` = `[{ "name": "idx-a", "url": "http://idx-a:7070" }, …]`.
- Propriétaire d'un vault : **hachage de rendez-vous**. Pour chaque instance, `h = FNV-1a 64 bits de (name + "|" + vaultId)` ; l'instance de plus grand `h` possède le vault (égalité : plus petit `name`). Ajouter une instance ne déplace qu'environ 1/n des vaults.
- Le pair ne connaît que son nom (`SAVOIRE_INDEXER_NAME`). C'est le backend qui filtre le flux par propriétaire : un seul calcul, un seul endroit.
- Un vault qui change de propriétaire est reconstruit par le nouveau ; l'ancien supprime son fichier au bout d'un délai (`SAVOIRE_INDEXER_ORPHAN_TTL`, 24 h par défaut).

## API interne (servie par le backend, appelée par le pair)

Préfixe `/internal/indexer`, jeton de service obligatoire, lecture seule.

| Route | Réponse |
|---|---|
| `GET /internal/indexer/vaults?instance={name}` | `{ vaults: [{ vaultId, name }] }` : les vaults que possède cette instance. |
| `GET /internal/indexer/changes?instance={name}&since={seq}&limit={n}` | `{ changes: [{ seq, vaultId, kind, docId? }], last }`. `kind` : `vault` (arborescence du vault modifiée), `document` (contenu d'un document modifié), `vault-deleted`. `seq` croît strictement sur tout le serveur ; `last` est la plus grande séquence examinée (le pair repart de là, même si aucune ligne ne le concerne). `limit` : 500 par défaut, 2 000 au plus. |
| `GET /internal/indexer/vaults/{vaultId}/tree` | `{ updates: [base64…] }` : le journal Yjs de l'arborescence du vault (après compaction éventuelle). |
| `GET /internal/indexer/vaults/{vaultId}/documents/{docId}` | `{ updates: [base64…] }` : le journal Yjs du document. 404 si le document n'existe pas. |

Le pair rejoue ces mises à jour dans un `Y.Doc` avec le même code que les clients, en extrait l'arborescence (chemins) et le contenu, puis libère le document.

## API du pair (servie par le pair, appelée par le backend)

Jeton de service obligatoire, sauf pour la santé.

| Route | Rôle |
|---|---|
| `POST /v1/vaults/{vaultId}/call` | Corps `{ capability, method, params, caller: { userId } }`. Réponse `{ result }`. |
| `POST /v1/search` | Recherche globale sur plusieurs vaults de cette instance. Corps `{ vaultIds, query: SearchQuery, caller }`. Réponse `SearchResult` (`hits[].vaultId` renseigné). |
| `GET /v1/vaults/{vaultId}/status` | `IndexState` + `{ seq, docs, bytes }`. |
| `GET /health/live` | 200 tant que le processus tourne. |
| `GET /health/ready` | 200 quand le flux de changements est suivi et que la file n'est pas saturée ; sinon 503. |
| `GET /metrics` | Format texte Prometheus. |

Erreurs (corps `{ error: { code, message } }`) :
- 400 `invalid_query`, `invalid_cursor`, `too_complex` (codes de `QueryErrorInfo`) ;
- 404 `unknown_capability` / `unknown_method` ;
- 409 `not_owner` (le vault appartient à une autre instance : le backend recalcule son routage) ;
- 429 `overloaded` (file pleine) avec `Retry-After` ;
- 503 `unavailable` avec `Retry-After`.

Un vault en construction répond quand même, avec `index.status = 'building'` et `progress` : résultats partiels, jamais d'erreur.

## Routes publiques (servies par le backend, appelées par les clients)

Authentification habituelle (jeton de l'utilisateur). Droit de **lecture** sur le vault vérifié à chaque appel (`VaultAccessBehavior`).

| Route | Rôle |
|---|---|
| `POST /api/v1/vaults/{vaultId}/index/{capability}/{method}` | Corps = `params`. Réponse = `result`. Relayé tel quel à l'instance propriétaire (`caller.userId` ajouté par le backend, jamais pris du client). |
| `POST /api/v1/search` | Corps `SearchQuery` + `vaultIds?` (sous-ensemble). Recherche globale sur les vaults que la personne peut lire ; le backend groupe les vaults par instance, appelle `/v1/search` en parallèle, fusionne par score. Une instance en échec donne `partial: true`, pas une erreur. |
| `GET /api/v1/vaults/{vaultId}/indexer` | Réglage du vault : `{ mode: 'managed' \| 'organization' \| 'none', url? }` + état. Lisible par les membres. |
| `PUT /api/v1/vaults/{vaultId}/indexer` | Modifiable par le propriétaire seul. |

- Limitation de débit (limiteur d'ASP.NET Core) par utilisateur et par vault ; 429 + `Retry-After`.
- Délai maximal d'un appel relayé : 5 s par défaut (`Indexer:TimeoutMs`) ; au-delà, 503.
- Taille maximale d'un corps : 64 Kio.
- Un lien de partage ne donne accès à aucune de ces routes.
- Mode `none` ou pair indisponible : 503 + `Retry-After`. Le client bascule alors sur son index local ou partagé et l'affiche.

## Pouvoirs (capacités) et méthodes

Noms stables. Les paramètres et résultats sont en JSON. Un pouvoir valide lui-même ses paramètres (bornes, types) et ne reçoit jamais de SQL.

| Capacité | Méthode | Paramètres → résultat |
|---|---|---|
| `query` | `run` | `Query` → `QueryResult` (`packages/plugin-api/src/query.ts`) |
| `search` | `run` | `SearchQuery` → `SearchResult` (`packages/plugin-api/src/search.ts`) |
| `links` | `backlinks` | `{ id }` → `{ items: [{ id, path, title, count }] }` |
| `links` | `outgoing` | `{ id }` → `{ resolved: [{ id, path, title }], unresolved: [{ target }] }` |
| `links` | `unresolved` | `{ limit? }` → `{ items: [{ target, count, sources: [id…] }] }` |
| `links` | `graph` | `{ folder?, limit? }` → `{ nodes: [{ id, path, title }], edges: [{ from, to }] }` |
| `tags` | `list` | `{}` → `{ items: [{ tag, count }] }` |
| `index` | `status` | `{}` → `IndexState` + `{ seq, docs }` |

Un nouveau pouvoir ajoute une ligne ici et un module dans `packages/indexer-core`. Le backend n'a rien à changer.

## Fonctionnement du pair

- Un fichier SQLite par vault (`{dataDir}/{vaultId}.sqlite`, mode WAL), ouvert à la demande, fermé quand il sort du cache (`SAVOIRE_INDEXER_MAX_OPEN`).
- Un seul écrivain par vault (l'indexation), plusieurs lecteurs.
- Priorités : appels interactifs, puis mises à jour au fil de l'eau, puis constructions initiales (bridées).
- Les changements d'une même note sont regroupés (fenêtre `SAVOIRE_INDEXER_DEBOUNCE_MS`, 1 000 ms par défaut).
- La dernière séquence traitée est écrite dans chaque SQLite et globalement : un redémarrage reprend où il s'était arrêté.
- Schéma versionné : une nouvelle version d'index se reconstruit à côté pendant que l'ancienne répond, puis bascule.
