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
- Authentification des deux sens, en `Authorization: Bearer` :
  - **en production (ADR-028)**, des jetons du fournisseur d'identité : le pair présente un jeton « client credentials » de son compte de service (reconnu par `Indexer:Oidc:PeerSubject`) ; l'API présente celui de son propre compte, que le pair vérifie (clés JWKS, émetteur, audience, sujet). Configuration écrite par `deploy/compose/zitadel/bootstrap.mjs` (`Indexer:Oidc` côté backend, `SAVOIRE_INDEXER_OIDC_FILE` côté pair) ;
  - sinon, un **jeton de service partagé** (`Indexer:ServiceToken` côté backend, `SAVOIRE_INDEXER_TOKEN` côté pair) : tests, installation sans fournisseur.
  Ni l'un ni l'autre : l'API interne n'existe pas et les routes publiques répondent 503.

## Répartition des vaults entre instances

- Liste des instances dans la configuration du backend : `Indexer:Instances` = `[{ "name": "idx-a", "url": "http://idx-a:7070" }, …]`.
- Propriétaire d'un vault : **hachage de rendez-vous**. Pour chaque instance, `h = FNV-1a 64 bits de (name + "|" + vaultId)` ; l'instance de plus grand `h` possède le vault (égalité : plus petit `name`). Ajouter une instance ne déplace qu'environ 1/n des vaults.
  - Précisions : FNV-1a sur les **octets UTF-8** de la chaîne, base `0xcbf29ce484222325`, premier `0x100000001b3`, multiplication modulo 2^64 ; `h` comparé comme **entier non signé** (en JavaScript : `BigInt`) ; égalité départagée par l'ordre ordinal des noms (unités UTF-16, comme `<` en JavaScript).
  - Seuls les vaults servis par le pair géré (réglage `managed`, voir plus bas) sont répartis.

### Vecteurs de test

FNV-1a 64 bits : `""` → `cbf29ce484222325`, `"a"` → `af63dc4c8601ec8c`, `"foobar"` → `85944171f73967e8`, `"é|v"` → `f92d6dc6f2df26e3`.

Trois instances `idx-a`, `idx-b`, `idx-c` (`h` en hexadécimal, propriétaire en gras) :

| vaultId | h(idx-a) | h(idx-b) | h(idx-c) | Propriétaire |
|---|---|---|---|---|
| `default` | `bf6099b93275125f` | `babf58d5c3c8d712` | `87b6a1c470f54ff5` | **idx-a** |
| `3f2504e0-4f89-41d3-9a0c-0305e82c3301` | `e4cfae3d98239042` | `c3ae9c9c249601ad` | `bf065ce4a9a8625c` | **idx-a** |
| `7c9e6679-7425-40de-944b-e07fc1f90ae7` | `3c7927c34e970ff4` | `5a77b6682bd716c7` | `57dd386b814f1a8e` | **idx-b** |
| `0b6f3c2e-9d61-4c1a-8b8e-2f1d5a7c9e40` | `ac06e4084913e640` | `6265b805fcd1a95f` | `761c05eb120ee032` | **idx-a** |
| `d3b07384-d9a0-4c3b-9f7e-1a2b3c4d5e6f` | `355a12b7f409c606` | `bc64cde977362895` | `fc0ea165c6324b60` | **idx-c** |
| `a1b2c3d4-e5f6-4789-8abc-def012345678` | `d69e24eece33a71b` | `74d2f0e6a4edb6ac` | `ec6dbf84eca90739` | **idx-c** |
| `11111111-2222-4333-8444-555555555555` | `11b9445279b33925` | `7bc8287759e80ede` | `f0c7d9e639eb2ed7` | **idx-c** |
| `ffffffff-ffff-4fff-bfff-ffffffffffff` | `10d32d04e0334fec` | `60dc234f797cdc5f` | `03c115cd1155b336` | **idx-b** |

Côté backend : `IndexerRouting` (`backend/Savoire.Application/Indexer/IndexerRouting.cs`), testé avec ces vecteurs (`tests/Server.Unit.Tests/Indexer/IndexerRoutingTests.cs`).
- Le pair ne connaît que son nom (`SAVOIRE_INDEXER_NAME`). C'est le backend qui filtre le flux par propriétaire : un seul calcul, un seul endroit.
- Un vault qui change de propriétaire est reconstruit par le nouveau ; l'ancien supprime son fichier au bout d'un délai (`SAVOIRE_INDEXER_ORPHAN_TTL`, 24 h par défaut).

## API interne (servie par le backend, appelée par le pair)

Préfixe `/internal/indexer`, jeton de service obligatoire, lecture seule. Sans jeton configuré : 404 (l'API n'existe pas). Jeton absent ou faux : 401 (comparaison en temps constant). Instance absente de `Indexer:Instances` : 400 `unknown_instance`.

| Route | Réponse |
|---|---|
| `GET /internal/indexer/vaults?instance={name}` | `{ vaults: [{ vaultId, name }] }` : les vaults que possède cette instance (servis par le pair géré). |
| `GET /internal/indexer/changes?instance={name}&since={seq}&limit={n}` | `{ changes: [{ seq, vaultId, kind, docId? }], last, epoch }`. `kind` : `vault` (arborescence du vault modifiée), `document` (contenu d'un document modifié), `settings` (types des propriétés du vault modifiés), `vault-deleted`. Un pair ignore une valeur qu'il ne connaît pas. `seq` croît strictement sur tout le serveur ; `last` est la plus grande séquence examinée (le pair repart de là, même si aucune ligne ne le concerne). `limit` : 500 par défaut, 2 000 au plus. `since` négatif : 400 `invalid_cursor`. |
| `GET /internal/indexer/vaults/{vaultId}/tree` | `{ updates: [base64…], format: "yjs" }` : le journal Yjs de l'arborescence du vault (après compaction éventuelle). 404 si le vault n'existe pas ou n'est pas servi par le pair géré. |
| `GET /internal/indexer/vaults/{vaultId}/documents/{docId}` | `{ updates: [base64…], format }` : le journal du document. 404 si le document n'est pas inscrit dans ce vault, ou si le vault n'est pas servi par le pair géré. Inscrit mais encore vide : `updates: []`. |
| `GET /internal/indexer/vaults/{vaultId}/settings/{section}` | `{ updates: [base64…], format: 'yjs' }` : le journal du canal de réglages `settings/{section}` (seule section lue : `properties`, les types des propriétés, carte Yjs `entries`). 404 pour une autre section, ou si le vault n'est pas servi par le pair géré. Le pair type les valeurs comme les clients ; quand les types changent (ligne `settings`), il reconstruit l'index à côté (raison `types`). Un backend plus ancien répond 404 : le pair indexe sans types. |

Précisions sur le flux :
- **Une ligne par ressource** (l'arborescence d'un vault, un document) : chaque écriture la déplace en fin de flux avec une nouvelle `seq`. Le flux ne grossit donc pas sans fin ; un pair qui reprend de loin voit chaque ressource une seule fois, avec sa dernière séquence. Plus une ligne `vault-deleted` par vault supprimé.
- Chaque écriture compte, quel que soit le chemin : opérations et compactions des documents (`SyncHub`), de l'arborescence (`VaultHub`), instantanés des rooms (`DocumentRoomHub`). Le changement est écrit dans la même transaction que l'écriture.
- `vault-deleted` : le vault est supprimé, **ou il sort du pair géré** (réglage `none` ou `organization`). Le pair supprime son index. Un changement `vault` ultérieur (retour au réglage `managed`) le fait reconstruire : `vault-deleted` n'est pas une pierre tombale.
- Les changements d'un vault hors du pair géré ne sont pas rendus (sauf `vault-deleted`).
- `epoch` identifie la base du backend. S'il change (base recréée, séquences reparties de zéro), le pair repart de `since=0` et reconstruit.
- Le backend examine au plus 20 000 lignes par appel ; `last` dit où il s'est arrêté.

`format` d'un journal :
- `yjs` : mises à jour Yjs, à rejouer dans un `Y.Doc` ;
- `json` : document « snapshot » d'une room (`DocumentRoomHub`, ex. tableau) : une seule entrée, le JSON UTF-8 de son dernier état, en base64. Le pair peut l'ignorer tant qu'aucun pouvoir ne le lit.

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

Précisions (pair, `apps/indexer`) :
- Autres réponses : 401 `unauthorized` (jeton absent ou faux, comparé en temps constant) ; 413 `payload_too_large` (corps au-delà de `SAVOIRE_INDEXER_MAX_BODY_BYTES`, 256 Kio) ; 405 `method_not_allowed` ; 404 `not_found` (route inconnue) ; 500 `internal` (erreur inattendue, journalisée ; le backend la rend en 503). Id de vault hors de `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, nom de pouvoir ou de méthode hors de `^[a-z][a-z0-9_-]{0,63}$`, corps qui n'est pas un objet JSON : 400 `invalid_query`.
- 409 `not_owner` : vault absent de la liste de l'instance, ou parti (`vault-deleted`, orphelin). Avant de répondre 409, un vault inconnu fait relire la liste (au plus une fois toutes les 5 s, 2 s d'attente au plus).
- 503 `unavailable` + `Retry-After` (`SAVOIRE_INDEXER_UNAVAILABLE_RETRY_AFTER_S`, 5 s) : pair qui démarre (liste des vaults pas encore lue) ou qui s'arrête, appel qui dépasse `SAVOIRE_INDEXER_CALL_TIMEOUT_MS` (4 s, attente comprise). 429 `overloaded` + `Retry-After` (`SAVOIRE_INDEXER_RETRY_AFTER_S`, 1 s) : plus de `SAVOIRE_INDEXER_MAX_QUEUE` appels en cours ou en attente.
- `POST /v1/search` : `query.limit` de 1 à 500 (50 par défaut) ; `vaultIds` : 1 000 au plus (400 `too_complex`). Fusion et curseur composé comme le backend entre instances (score décroissant, puis `vaultId`, puis `id` ; par vault : `{ c: curseur, s: déjà rendus }`, base64url d'un JSON). Un vault qui n'est pas à l'instance ou qui ne répond pas est ignoré avec `partial: true` ; un 400 d'un vault est rendu tel quel ; aucun vault n'a répondu : 503 (429 si tous étaient freinés).
- `/metrics` demande le jeton de service, sauf `SAVOIRE_INDEXER_METRICS_AUTH=none`. `/health/ready` rend aussi le détail (`following`, `shards`, `queue`, `listed`, `catchingUp`, `stopping`).
- L'état rendu avec chaque résultat : `building` (+ `progress`) pendant une construction ; `lagging` (+ `lagMs`) quand le plus vieux changement non traité, ou la dernière lecture réussie du flux, date de plus de `SAVOIRE_INDEXER_LAG_WARN_MS` (5 s) ; sinon `ready`.

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

Précisions (backend) :
- Erreurs des routes publiques, toutes en `{ error: { code, message } }` :
  - celles du pair (400, 404, 429, 503) passent telles quelles (seuls `code` et `message`), avec son `Retry-After` ;
  - 409 `not_owner` : le backend recalcule le propriétaire et réessaie **une** fois ; un second refus donne 503 `unavailable` + `Retry-After` ;
  - pair injoignable, délai dépassé, réponse trop grosse ou illisible, jeton refusé, autre statut : 503 `unavailable` + `Retry-After` (`Indexer:RetryAfterSeconds`, 5 s) ;
  - 429 `rate_limited` + `Retry-After` : limite de débit du backend (par personne, puis par vault) ;
  - 413 `payload_too_large` : corps de plus de `Indexer:MaxBodyBytes` ; 400 `invalid_query` : corps qui n'est pas du JSON, ou nom de pouvoir / méthode hors de `^[a-z][a-z0-9_-]{0,63}$`.
- Droits : non-membre 404 (masqué, comme le reste de l'API) ; lien de partage ou jeton `view:` 403 ; sans compte 401.
- Mode `none` : 503 `{ error, mode: "none" }` + `Retry-After`. Mode `organization` : le backend ne relaie pas, 503 `{ error, mode: "organization", url }` **sans** `Retry-After` : le client sait où aller (le circuit du pair d'organisation viendra avec le profil chiffré).
- `GET …/indexer` → `{ mode, url?, state? }`. `url` seulement en mode `organization`. `state` : réponse de `GET /v1/vaults/{id}/status` du pair géré, ou `{ status: "unavailable" }` (pair absent, mode `none`) ; absent en mode `organization`.
- `PUT …/indexer`, corps `{ mode, url? }` : `url` (http(s) absolue, 2 048 caractères au plus) obligatoire en mode `organization`, interdite sinon. Réponse : le réglage. Sortir du pair géré ou y revenir s'inscrit dans le flux (`vault-deleted` / `vault`).
- `POST /api/v1/search` :
  - corps `SearchQuery` + `vaultIds?` (1 000 au plus ; les vaults non lisibles sont ignorés, pas d'erreur) ; seuls les vaults en mode `managed` sont cherchés ;
  - chaque instance reçoit `{ vaultIds, query, caller }`, `query` sans `vaultIds` et avec son propre curseur ; au plus `Indexer:SearchParallelism` instances à la fois ;
  - fusion : score décroissant, puis `vaultId`, puis `id`. `total` = somme des `total`, `index` = le moins avancé ;
  - `next` est un curseur **composé**, opaque (par instance : son curseur et le nombre de résultats déjà rendus de sa page). Une page peut être plus courte que `limit` : on ne classe pas ce qu'une instance n'a pas encore rendu ;
  - une requête refusée par une instance (400) est rendue telle quelle ; une instance en échec donne `partial: true` (reporté sur les pages suivantes) ; toutes en échec : 503.

### API ouverte (jetons personnels)

Pour les outils externes (GPT, Claude, n8n, scripts). Jeton personnel `svp_…` (Paramètres → API), schéma d'authentification `access-token`, accepté **seulement** sur ces routes. Le jeton agit au nom de la personne ; il peut être limité à des vaults (403 `forbidden_vault` sinon). Lecture seule. Mêmes limites de débit que les routes publiques.

| Route | Rôle |
|---|---|
| `GET/POST/DELETE /api/v1/me/access-tokens[/{id}]` | Gestion des jetons (compte connecté). Le jeton complet n'est rendu qu'à la création ; le serveur n'en garde que l'empreinte SHA-256. 50 jetons actifs au plus. |
| `GET /api/open/v1/openapi.yaml` | Description OpenAPI (sans jeton), adresse du serveur comprise. |
| `GET /api/open/v1/vaults` | Vaults du jeton. |
| `POST /api/open/v1/vaults/{id}/search` | `{ text, limit?, folder? }` → `search.run` (limit 50 au plus). |
| `GET /api/open/v1/vaults/{id}/notes` | `?folder&limit&cursor` → `query.run` sur les notes, par chemin. |
| `GET /api/open/v1/vaults/{id}/notes/read` | `?path` ou `?id` → `documents.read`. |
| `POST /api/open/v1/vaults/{id}/query` | Corps = `Query` → `query.run`. |
| `POST /api/mcp` | Serveur MCP (transport HTTP, un message JSON-RPC par requête, réponse JSON ; pas de flux SSE). Outils : `list_vaults`, `search`, `list_notes`, `read_note` ; un vault se désigne par id ou par nom. |

## Index partagé compacté (canaux d'index du profil serveur)

Étape 8 de l'ADR. Un canal d'index (`VaultHub.JoinIndex` / `PushIndexUpdate`) est un journal de mises à jour Yjs opaques. Pour qu'il ne grossisse pas sans fin :
- `VaultHub.SnapshotIndex(vaultId, ns, snapshotBase64)`, mêmes droits que `PushIndexUpdate` (écrire dans le vault) ;
- le serveur remplace par cet état **exactement** les trames que cette connexion a reçues à `JoinIndex` (il garde leurs identifiants pour la connexion). Une trame arrivée depuis reste. Si aucune de ces trames n'existe plus (une autre compaction est passée), rien n'est écrit ;
- le client l'appelle quand il a rejoué plus de 100 trames en rejoignant le canal (`INDEX_COMPACT_THRESHOLD`, comme le répertoire du vault et les documents) ;
- sûr à plusieurs : l'état d'un client contient tout ce qu'il a rejoué ; les écritures concurrentes ne sont pas dans sa liste ; deux états Yjs se fusionnent sans perte si deux compactions se recouvrent en partie.

## Pouvoirs (capacités) et méthodes

Noms stables. Les paramètres et résultats sont en JSON. Un pouvoir valide lui-même ses paramètres (bornes, types) et ne reçoit jamais de SQL.

| Capacité | Méthode | Paramètres → résultat |
|---|---|---|
| `query` | `run` | `Query` → `QueryResult` (`packages/plugin-api/src/query.ts`) ; `aggregate` (count, sum, mean, min, max, 32 au plus) rend `aggregates`, calculés sur tout le résultat. Un pair plus ancien les ignore : le client le voit à l'absence de `aggregates` et lit les lignes. Un champ peut être `{ formula }` (filtre, tri, groupe, agrégat) : SQL retient d'abord ce qu'il sait, puis la formule est évaluée en JS sur place (250 000 lignes au plus, sinon `too_complex`), 8 formules par requête. Un pair plus ancien répond `invalid_query` : le client calcule lui-même. |
| `search` | `run` | `SearchQuery` → `SearchResult` (`packages/plugin-api/src/search.ts`) |
| `links` | `backlinks` | `{ id, limit? }` → `{ items: [{ id, path, title, count }] }` : notes qui pointent vers `id` (sans elle-même), par chemin ; `limit` 1 000 par défaut, 10 000 au plus. |
| `links` | `outgoing` | `{ id }` → `{ resolved: [{ id, path, title }], unresolved: [{ target }] }` (ordre du texte) |
| `links` | `unresolved` | `{ limit? }` → `{ items: [{ target, count, sources: [id…] }] }` : les plus nombreux d'abord ; `limit` 200 par défaut, 5 000 au plus ; 50 sources au plus par cible. |
| `links` | `graph` | `{ folder?, limit? }` → `{ nodes: [{ id, path, title }], edges: [{ from, to }] }` : au-delà de `limit` (2 000 par défaut, 20 000 au plus), les notes les plus reliées d'abord ; 100 000 arêtes au plus. |
| `tags` | `list` | `{ prefix?, limit? }` → `{ items: [{ tag, count }] }` : `count` = nombre de notes ; casse ignorée ; `prefix` : ce tag et ses sous-tags ; `limit` 1 000 par défaut, 10 000 au plus. |
| `tags` | `notes` | `{ tag, limit? }` → `{ items: [{ id, path, title }] }` : notes du tag, sous-tags compris (`a` donne aussi `a/b`) ; `limit` 500 par défaut, 5 000 au plus. |
| `index` | `status` | `{}` → `IndexState` + `{ seq, docs, bytes }` |
| `documents` | `read` | `{ id }` ou `{ path }` (casse ignorée) → `{ id, path, title, content, truncated }` : le texte d'une note en Markdown, relu dans son CRDT chez le backend (pas dans l'index) ; pour un fichier, le texte extrait ou publié. 512 Ki caractères au plus. 404 `not_found` si absent ou à la corbeille. Pouvoir du pair, hors index : sert l'API ouverte. |

Résolution des liens (pouvoir `links`, façon Obsidian) : chemin exact (avec ou sans extension ; relatif au dossier de la note d'abord pour un lien « ./ », « ../ » ou Markdown), sinon nom de fichier sans extension (casse ignorée ; « a/b » exige un chemin qui finit par « /a/b » ; en cas d'ambiguïté le `.md`, puis le plus court chemin, puis l'ordre alphabétique), sinon alias du frontmatter.

Un nouveau pouvoir ajoute une ligne ici et un module dans `packages/indexer-core`. Le backend n'a rien à changer.

## Côté client (appli)

Le pair est une **capacité de la session** du vault : `IVaultSyncSession.indexer` (`IVaultIndexer`, `packages/application/src/VaultIndexer.ts`), fournie par le profil serveur (`RemoteVaultIndexer`, `packages/infrastructure-sync/src/RemoteVaultIndexer.ts`, client HTTP `IndexerHttpClient.ts`). Un profil sans pair ne la fournit pas ; l'appli garde alors ses index locaux.

Ce que reçoivent les plugins (tous en permission `vault:read`) :

| API | Fournisseur (`packages/application`) | Moteur préféré | Secours |
|---|---|---|---|
| `api.query` | `QueryEngineProvider` | pair (`setPreferred(remote.query, { readYourWrites: true })`) ou SQLite local | moteur en mémoire (canal `metadata`) |
| `api.search` | `SearchEngineProvider` | pair ou SQLite local | `FullTextFallbackSearch` : plein texte local des notes ouvertes (MiniSearch), état `unavailable` |
| `api.search.global` | `SearchEngineProvider` | `POST /api/v1/search` | absent |
| `api.indexer` | `IndexerPowersProvider` | pair (`indexerSourceOf`) ou index local (`call`) | `available()` faux : le plugin garde son comportement local |

`api.indexer` (`packages/plugin-api/src/indexer.ts`) : `available()`, `state()`, `onStateChange()`, `links.{backlinks, outgoing, unresolved, graph}`, `tags.{list, notes}`, `status()` ; mêmes paramètres et résultats que le tableau des pouvoirs. Un appel rejette avec un `QueryErrorInfo` : `unavailable` (pair coupé, freiné, appel annulé, pouvoir inconnu) → comportement local. Branchés : rétroliens (`plugin-wikilinks`, `links.backlinks`), graphe (`plugin-graph`, `links.graph`, 2 000 notes au plus), hashtags (`plugin-hashtags`, `tags.list` et `tags.notes`).

`api.search.global` (`IGlobalSearch`, `search.ts`) : `search(query & { vaultIds? })`, `open(hit)` (ouvre le vault de la note, puis la note). Les résultats portent `vaultId` et `vaultName` ; `partial` est affiché.

Règles du client :
- **Délai** : 10 s par appel (le backend coupe déjà à 5 s) ; au-delà, l'appel est abandonné (`unavailable`).
- **Jeton** : un 401 renouvelle le jeton et rejoue une fois (`fetchWithRenewal`).
- **Refus** : 503, réseau ou délai → état `unavailable` (raison `down`) ; 429 → état `lagging` (raison `busy`) ; 503 `mode: none` → raison `none` ; 503 `mode: organization` → raison `organization` + `url` (le client garde ses index locaux et le dit ; le circuit du pair d'organisation viendra avec le profil chiffré) ; 401/403/404 → raison `denied`. Les 400 (`invalid_query`, `invalid_cursor`, `too_complex`) et 413 rejettent l'appel sans changer l'état.
- **Pas de rafale** : après un refus, aucun appel avant l'échéance (`max(Retry-After, attente)`, l'attente valant 5 s puis doublant jusqu'à 60 s ; 60 s pour `none`, `organization`, `denied`). Pendant ce temps les appels rejettent tout de suite avec `unavailable`. À l'échéance, un seul `index.status` ; s'il répond, les requêtes suivies repartent du pair.
- **Un seul minuteur** lit `index.status` : à l'ouverture du vault (avec le réglage), 1,5 s après une modification locale (puis 2, 4, 8 s tant qu'elle n'est pas vue), toutes les 30 s tant que quelqu'un suit (5 s en construction ou en retard).
- **Requêtes suivies** (`watch`) : relancées seulement si `seq` a avancé, si le pair revient, ou pendant une construction ; une requête en cours et une en attente au plus, par requête suivie.
- **Lecture de ses propres écritures** : une modification locale est « en attente » (`VaultIndexerStatus.pending`) jusqu'à ce que `seq` ait avancé depuis et qu'elle ait plus de 1,5 s (20 s au plus). Pendant 15 s, `QueryEngineProvider` remplace dans les lignes du pair les valeurs (`values`, `path`) des notes et lignes de base modifiées ici par les valeurs locales, et redonne aussitôt les requêtes suivies corrigées. Une note qui entre dans un résultat ou en sort n'y apparaît qu'une fois le pair à jour. La recherche n'est pas corrigée : l'indicateur affiche « mise à jour… » tant qu'une modification est en attente.
- **Moteur préféré indisponible** : `QueryEngineProvider` et `SearchEngineProvider` passent sur le secours sans appeler le pair, état `unavailable` ; les requêtes suivies basculent, puis reviennent quand le pair répond. Pas de rattrapage des notes jamais indexées (`indexNow`) tant que le pair répond.
- **État visible** : indicateur de la barre du haut (`apps/web/src/IndexStatusIndicator.tsx`) : prêt, en construction (%), en retard, freiné, indisponible (mode dégradé : recherche limitée aux notes ouvertes), raison au survol ; un clic relance le pair quand il ne répond pas.
- **Réglage du vault** : onglet « Vault » des réglages (`VaultIndexerSettings.tsx`), `GET`/`PUT …/indexer` ; modifiable par le propriétaire seul, visible des membres, avec l'état du pair.

## Fonctionnement du pair

- Un fichier SQLite par vault (`{dataDir}/{vaultId}.sqlite`, mode WAL), ouvert à la demande, fermé quand il sort du cache (`SAVOIRE_INDEXER_MAX_OPEN`).
- Un seul écrivain par vault (l'indexation), plusieurs lecteurs.
- Priorités : appels interactifs, puis mises à jour au fil de l'eau, puis constructions initiales (bridées).
- Les changements d'une même note sont regroupés (fenêtre `SAVOIRE_INDEXER_DEBOUNCE_MS`, 1 000 ms par défaut).
- La dernière séquence traitée est écrite dans chaque SQLite et globalement : un redémarrage reprend où il s'était arrêté.
- Schéma versionné : une nouvelle version d'index se reconstruit à côté pendant que l'ancienne répond, puis bascule.

Précisions (réalisation, `apps/indexer/README.md`) :
- Fils d'exécution : les vaults sont répartis entre `SAVOIRE_INDEXER_WORKERS` fils (`worker_threads`, FNV-1a 32 bits de l'id modulo le nombre de fils). Un vault vit dans un seul fil : un seul écrivain. Dans un fil, une seule tâche SQLite à la fois (`node:sqlite` est synchrone), choisie par priorité (appels, puis mises à jour, puis constructions ; une tâche basse qui attend trop passe devant, une fois sur quatre au plus). Les lectures du backend se font hors de ce créneau.
- Reprise : la position sûre du flux (la plus petite séquence pas encore traitée, tous vaults confondus) est écrite chaque seconde dans `{dataDir}/indexer-state.json` (avec l'époque et le nom de l'instance). Chaque index garde sa séquence et l'époque qui l'a construit (`meta`, clé `host:epoch`) : un changement déjà appliqué (`seq` ≤ celle de l'index) est ignoré au rejeu. Un fil qui tombe est relancé et le flux rejoué depuis la position sûre.
- Construction : en place (fichier absent, noyau d'une autre version, construction interrompue, fichier illisible) ou à côté (`{vaultId}.sqlite.building` : version d'un pouvoir changée, époque changée, index périmé d'un vault revenu). À côté, l'ancien index répond pour ses pouvoirs intacts et suit le flux ; ce que le flux a changé pendant la construction est rejoué sur le nouveau, puis renommage. Un changement vu avant qu'une construction lise la note (ou l'arbre) est déjà dedans : il n'est pas rejoué.
- Orphelin : un vault qui n'est plus dans la liste de l'instance est fermé et marqué `{vaultId}.sqlite.stale` (date), supprimé après `SAVOIRE_INDEXER_ORPHAN_TTL` ; s'il revient avant, il est reconstruit à côté (il a manqué des changements).
- Lignes légères : un changement `document` dont l'id est `<id de base>~lot-NNN` relit ce lot (seules les lignes changées sont réécrites quand le lot est déjà connu ; les lignes parties sont retirées). Le document de la base (`.base`, dans l'arbre) donne `lotCount` et la liste des lots ; une base qui part à la corbeille ou disparaît de l'arbre perd ses lignes, une base restaurée est relue en entière. Les types de propriétés du vault ne sont pas encore lus par le pair (les valeurs sont typées d'après elles-mêmes, comme le secours des clients).
- Un dossier de données par instance (fichier `.lock`) ; SSD local, jamais un partage réseau.
