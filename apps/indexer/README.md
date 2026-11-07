<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- SPDX-FileCopyrightText: 2026 Jean Leloup -->
# Savoire Indexer

Le **pair indexeur** de Savoire (ADR-027, étape 3). Un service Node 24 qui lit les vaults par l'API interne du backend, tient un index SQLite **dérivé** par vault (jamais synchronisé, toujours reconstructible depuis les CRDT), et répond aux requêtes de toute l'appli : bases et requêtes (`query`), recherche plein texte et recherche globale (`search`), liens et graphe (`links`), tags (`tags`), état (`index`). Il n'est jamais exposé : le backend authentifie les clients, vérifie leurs droits, puis relaie à l'instance qui possède le vault.

- Contrat (routes, erreurs, répartition, pouvoirs) : `docs/Architecture/indexer-protocol.md`.
- Noyau d'indexation (le même que chez les clients complets) : `packages/indexer-core`.
- Aucune dépendance npm à l'exécution : `node:http`, `node:sqlite`, `fetch`, `worker_threads`. Le paquet construit est **un seul fichier** (`dist/indexer.mjs`, esbuild).

```
client ──HTTPS──▶ backend ──HTTP privé──▶ instances du pair (idx-a, idx-b…)
                    ▲                          │
                    └──── API interne ◀────────┘  (flux de changements, journaux Yjs)
```

## Démarrer

```bash
cd apps/indexer && node build.mjs            # dist/indexer.mjs
SAVOIRE_INDEXER_NAME=idx-a \
SAVOIRE_INDEXER_TOKEN=… \
SAVOIRE_INDEXER_BACKEND_URL=http://api:8080 \
node dist/indexer.mjs
node dist/indexer.mjs --help                 # toutes les variables
node dist/indexer.mjs --check                # vérifie la configuration et s'arrête
```

Côté backend : `Indexer:ServiceToken` (le même jeton) et `Indexer:Instances` (`[{ "Name": "idx-a", "Url": "http://idx-a:7070" }]`), voir `backend/Savoire.API/appsettings.Example.json`. Docker : `apps/indexer/Dockerfile` et le service `indexer` de `deploy/compose/docker-compose.yml`.

En production (ADR-028), pas de jeton partagé : le pair a son identité chez le fournisseur d'identité (Zitadel). `SAVOIRE_INDEXER_OIDC_FILE` désigne le fichier écrit par `deploy/compose/zitadel/bootstrap.mjs` (`indexer-oidc.json`) : le pair y prend ses identifiants (client credentials) pour appeler l'API, et n'accepte que les jetons du compte de service de l'API, vérifiés par les clés publiées du fournisseur (JWKS). Côté backend : `Indexer:Oidc` (écrit dans `savoire-oidc.json`). Le jeton partagé reste accepté s'il est configuré (tests).

## Ce qu'il fait

1. **Liste** les vaults de l'instance (`GET /internal/indexer/vaults?instance=`), puis **suit le flux** (`GET …/changes?since=`) : cadence rapide quand ça bouge (100 ms), ralentie au repos (500 ms), pages de 2 000 pendant un rattrapage.
2. **Construit** les vaults absents ou à refaire, en tâche de fond et bridé (2 à la fois par défaut) : l'arbre du vault, puis les notes par lots (une transaction par lot, le lot suivant se lit pendant que celui-ci s'écrit), puis les bases et leurs lignes légères. Jamais tout un vault en mémoire : lire, extraire, libérer. Pendant ce temps le vault répond (`status: building`, `progress`).
3. **Au fil de l'eau** : les changements d'une note sont regroupés (`DEBOUNCE_MS`, 1 s ; au plus `DEBOUNCE_MAX_MS`, 5 s, pour une frappe continue), puis la note est relue et indexée. Un changement de l'arbre est comparé à l'index : ajouts, renommages (sans relire le contenu), corbeille, suppressions. Les lots de lignes légères (`<base>~lot-NNN`) sont relus ; seules les lignes changées sont réécrites.
4. **`vault-deleted`** : index fermé et supprimé (un retour au pair géré le fait reconstruire). **Époque** changée (base du backend recréée) : relecture du flux depuis 0, tous les index reconstruits à côté.
5. **Répond** : `POST /v1/vaults/{id}/call`, `POST /v1/search` (plusieurs vaults, fusion par pertinence, curseur composé), `GET /v1/vaults/{id}/status`, `/health/live`, `/health/ready`, `/metrics`.

### Dedans

- **Fils d'exécution** (`SAVOIRE_INDEXER_WORKERS`) : chaque vault vit dans un seul fil (FNV-1a de l'id), donc un seul écrivain. Le fil principal ne fait que HTTP, le flux et le cache : il reste réactif même pendant une grosse requête.
- **Un SQLite par vault** (`{dataDir}/{vaultId}.sqlite`, WAL, `synchronous=NORMAL`), ouvert à la demande, fermé par le cache LRU (`MAX_OPEN`). Écritures groupées en transactions.
- **Priorités** : dans chaque fil, une seule tâche SQLite à la fois (`node:sqlite` est synchrone), choisie dans cet ordre : appels interactifs, mises à jour au fil de l'eau, constructions. Une tâche basse qui attend trop passe devant de temps en temps (pas de famine). Les lectures du backend se font hors de ce créneau.
- **File bornée** : au-delà de `MAX_QUEUE` appels en cours ou en attente, 429 `overloaded` + `Retry-After`. Délai par appel (`CALL_TIMEOUT_MS`, attente comprise) : au-delà, 503 et la tâche est abandonnée ; une requête HTTP coupée annule son appel.
- **Cache de résultats** : clé (vault, capacité, méthode, paramètres en JSON trié) **et génération de l'index** du vault ; toute écriture, tout changement d'état fait avancer la génération, donc une entrée ne sert jamais un index qui a bougé. Court (10 s), borné en entrées et en octets. Désactivé quand le flux n'est pas suivi.
- **Schéma versionné** : au démarrage, chaque index est inspecté sans être modifié (`VaultIndex.inspect`). Noyau d'une autre version, fichier absent ou abîmé, construction interrompue : reconstruction **en place**. Version d'un pouvoir changée, époque changée, index périmé (vault revenu) : reconstruction **à côté** (`{id}.sqlite.building`) ; l'ancien répond pour ses pouvoirs intacts et suit le flux, ce qui a changé pendant la construction est rejoué sur le nouveau, puis bascule par renommage.
- **Reprise** : la position sûre du flux (plus petite séquence pas encore traitée) est écrite chaque seconde dans `indexer-state.json` (fichier temporaire, fsync, renommage) ; chaque index garde aussi sa séquence et l'époque qui l'a construit. Après un arrêt, même brutal, le pair rejoue le flux depuis cette position et ignore ce qu'un index a déjà : pas de reconstruction.

## Configuration

Variables d'environnement, vérifiées au démarrage (toutes les erreurs d'un coup, code de sortie 78). Une variable `SAVOIRE_INDEXER_*` inconnue est signalée (faute de frappe). Durées : `500` (ms), `30s`, `15m`, `24h`, `7d` ; tailles : `65536`, `256KiB`, `32MiB`. `SAVOIRE_INDEXER_TOKEN_FILE` : lire le jeton dans un fichier (secrets Docker / Kubernetes). `SAVOIRE_INDEXER_OIDC_FILE` : identité de service chez le fournisseur d'identité (voir plus haut) ; le jeton devient alors facultatif.

| Variable | Defaut | Role |
|---|---|---|
| `SAVOIRE_INDEXER_NAME` | `(obligatoire)` | Nom de cette instance, tel qu'il figure dans `Indexer:Instances` du backend. Obligatoire. |
| `SAVOIRE_INDEXER_TOKEN` | `(obligatoire)` | Jeton de service partage avec le backend (`Indexer:ServiceToken`), 16 caracteres au moins. Obligatoire, sauf `SAVOIRE_INDEXER_TOKEN_FILE` ou `SAVOIRE_INDEXER_OIDC_FILE` (identite chez le fournisseur d'identite, ADR-028). |
| `SAVOIRE_INDEXER_BACKEND_URL` | `(obligatoire)` | Adresse du backend sur le reseau prive (API interne `/internal/indexer`). Obligatoire. |
| `SAVOIRE_INDEXER_DATA_DIR` | `./data` | Dossier des index : un `{vaultId}.sqlite` par vault, plus l'etat du flux. SSD local (jamais un partage SMB/NFS). |
| `SAVOIRE_INDEXER_HOST` | `0.0.0.0` | Adresse d'ecoute. |
| `SAVOIRE_INDEXER_PORT` | `7070` | Port d'ecoute (0 : choisi par le systeme). |
| `SAVOIRE_INDEXER_WORKERS` | `auto` | Fils d'execution qui portent les index (un vault = un fil, donc un seul ecrivain). 0 : tout dans le fil principal. Defaut : coeurs - 1, entre 1 et 4. |
| `SAVOIRE_INDEXER_MAX_OPEN` | `128` | Fichiers SQLite ouverts a la fois (toute l'instance) ; au-dela, les moins recemment utilises sont fermes. |
| `SAVOIRE_INDEXER_SQLITE_CACHE_KIB` | `2048` | Cache de pages SQLite par fichier ouvert (Kio). Memoire au pire : MAX_OPEN x cette valeur. |
| `SAVOIRE_INDEXER_DEBOUNCE_MS` | `1000` | Regroupement des changements d'une note : relue quand elle n'a plus change depuis ce delai. |
| `SAVOIRE_INDEXER_DEBOUNCE_MAX_MS` | `5000` | Attente maximale d'une note qui change sans arret (frappe continue). |
| `SAVOIRE_INDEXER_ORPHAN_TTL` | `24h` | Delai avant de supprimer l'index d'un vault qui n'appartient plus a cette instance (`30s`, `15m`, `24h`, `7d` ou des ms). |
| `SAVOIRE_INDEXER_BUILD_CONCURRENCY` | `2` | Vaults construits en meme temps (toute l'instance). Les constructions passent apres les appels et les mises a jour. |
| `SAVOIRE_INDEXER_BUILD_BATCH` | `50` | Notes ecrites par transaction pendant une construction (plus petit : appels moins retardes). |
| `SAVOIRE_INDEXER_FETCH_CONCURRENCY` | `8` | Lectures de documents en parallele vers le backend, par fil. |
| `SAVOIRE_INDEXER_FEED_LIMIT` | `500` | Changements demandes par appel au flux (2 000 pendant un rattrapage). |
| `SAVOIRE_INDEXER_FEED_ACTIVE_MS` | `100` | Cadence du flux quand il bouge. |
| `SAVOIRE_INDEXER_FEED_IDLE_MS` | `500` | Cadence du flux au repos (la cadence ralentit jusqu'a cette valeur). Avec DEBOUNCE, borne le delai d'indexation. |
| `SAVOIRE_INDEXER_FEED_STALE_MS` | `30000` | Sans reponse du flux depuis ce delai : `ready` faux, index rendus « en retard ». |
| `SAVOIRE_INDEXER_VAULTS_REFRESH_MS` | `60000` | Relecture de la liste des vaults de l'instance (changement de repartition, orphelins). |
| `SAVOIRE_INDEXER_BACKEND_TIMEOUT_MS` | `15000` | Delai maximal d'un appel au backend. |
| `SAVOIRE_INDEXER_BACKEND_RETRIES` | `3` | Nouveaux essais d'une lecture qui echoue (reseau, 5xx), avec attente croissante. |
| `SAVOIRE_INDEXER_MAX_DOC_BYTES` | `32MiB` | Taille maximale d'une reponse du backend (journal d'un document ou de l'arbre) ; au-dela, le document est ignore et signale. |
| `SAVOIRE_INDEXER_CALL_TIMEOUT_MS` | `4000` | Delai maximal d'un appel (attente comprise) ; au-dela, 503. Garder sous `Indexer:TimeoutMs` du backend (5 s). |
| `SAVOIRE_INDEXER_MAX_QUEUE` | `256` | Appels en cours ou en attente (toute l'instance) ; au-dela, 429 `overloaded`. |
| `SAVOIRE_INDEXER_RETRY_AFTER_S` | `1` | `Retry-After` d'un 429. |
| `SAVOIRE_INDEXER_UNAVAILABLE_RETRY_AFTER_S` | `5` | `Retry-After` d'un 503. |
| `SAVOIRE_INDEXER_MAX_BODY_BYTES` | `256KiB` | Taille maximale d'un corps de requete ; au-dela, 413. |
| `SAVOIRE_INDEXER_SEARCH_MAX_VAULTS` | `1000` | Vaults d'une recherche globale, au plus ; au-dela, 400 `too_complex`. |
| `SAVOIRE_INDEXER_SEARCH_PARALLELISM` | `8` | Recherche globale : vaults interroges en meme temps. |
| `SAVOIRE_INDEXER_CACHE_ENTRIES` | `2000` | Resultats gardes en cache (0 : pas de cache). Une entree ne sert que tant que l'index du vault n'a pas bouge. |
| `SAVOIRE_INDEXER_CACHE_MAX_BYTES` | `64MiB` | Taille maximale du cache de resultats. |
| `SAVOIRE_INDEXER_CACHE_TTL_MS` | `10000` | Duree de vie d'un resultat en cache. |
| `SAVOIRE_INDEXER_LAG_WARN_MS` | `5000` | Retard au-dela duquel un index est rendu `lagging` (avec `lagMs`). |
| `SAVOIRE_INDEXER_STATS_INTERVAL_MS` | `30000` | Rafraichissement des tailles et nombres de notes par vault (metriques). |
| `SAVOIRE_INDEXER_METRICS_AUTH` | `token` | `/metrics` demande le jeton de service (`token`) ou non (`none`, reseau prive seulement). |
| `SAVOIRE_INDEXER_METRICS_MAX_VAULTS` | `1000` | Vaults detailles dans `/metrics` (les plus gros, en retard ou en construction d'abord) ; 0 : aucun. |
| `SAVOIRE_INDEXER_SLOW_CALL_MS` | `1000` | Appel journalise en avertissement au-dela de cette duree. |
| `SAVOIRE_INDEXER_SHUTDOWN_TIMEOUT_MS` | `15000` | Arret propre (SIGTERM) : attente maximale des appels et ecritures en cours. |
| `SAVOIRE_INDEXER_LOG_LEVEL` | `info` | Niveau du journal (JSON, une ligne par evenement). |
| `SAVOIRE_INDEXER_ERROR_DSN` | `` | Suivi des erreurs : DSN d'un projet GlitchTip (ou Sentry). Chaque ligne de journal `error` y est aussi envoyee. Vide : rien n'est envoye. |
| `SAVOIRE_INDEXER_ERROR_ENVIRONMENT` | `production` | Environnement annonce dans les rapports d'erreur. |

## Exploitation

### Mettre à l'échelle

Les vaults sont répartis entre instances par **hachage de rendez-vous** (calculé par le backend seul). Pour ajouter une instance :

1. lancer `idx-b` : même image, `SAVOIRE_INDEXER_NAME=idx-b`, **son propre volume** ;
2. l'ajouter à `Indexer:Instances` du backend (`Indexer__Instances__1__Name=idx-b`, `…__Url=http://idx-b:7070`) et redémarrer le backend.

Ce qui se passe : environ 1/n des vaults changent de propriétaire. `idx-b` les trouve dans sa liste et les construit (bridé, en tâche de fond ; pendant ce temps ils répondent `building` avec `progress`, résultats partiels). `idx-a` ne reçoit plus leurs changements ; à sa relecture de la liste (`VAULTS_REFRESH_MS`, 1 min), il les ferme, les marque orphelins (409 `not_owner` s'il est encore appelé : le backend recalcule son routage) et supprime leurs fichiers après `ORPHAN_TTL` (24 h). Si un vault revient avant (instance retirée), il est reconstruit à côté.

Dans une instance, `WORKERS` répartit les vaults sur plusieurs cœurs. Mémoire : environ 60 Mo par fil + le cache SQLite des fichiers ouverts (`MAX_OPEN` × `SQLITE_CACHE_KIB` au pire) + le cache de résultats. Disque : environ 7 Ko par note (10 000 notes : 68 Mo).

### Santé

- `GET /health/live` : 200 tant que le processus répond (HEALTHCHECK de l'image).
- `GET /health/ready` : 200 quand la liste est lue, le flux suivi (réponse depuis moins de `FEED_STALE_MS`), tous les fils vivants et la file à moins de 90 % ; sinon 503, avec le détail.

### Métriques (`GET /metrics`, jeton de service sauf `METRICS_AUTH=none`)

| Métrique | Sens |
|---|---|
| `savoire_indexer_ready`, `_uptime_seconds`, `_info{version,name,node}` | état général |
| `_feed_cursor`, `_feed_persisted_cursor`, `_feed_last_success_age_seconds`, `_feed_catching_up`, `_feed_polls_total{result}`, `_epoch_changes_total` | suivi du flux |
| `_calls_total{capability,method,status}`, `_call_duration_seconds` (histogramme), `_call_latency_seconds{capability,quantile}` (p50/p95/p99 sur 5 min) | appels |
| `_inflight_calls{shard}`, `_queue_capacity`, `_queue_depth{shard,priority}`, `_rejected_total{reason}` | file et refus (`overloaded`, `timeout`, `not_owner`, `unauthorized`…) |
| `_cache_hits_total`, `_cache_misses_total`, `_cache_evictions_total`, `_cache_entries`, `_cache_bytes` | cache |
| `_vaults{state,shard}`, `_open_files`, `_builds_running`, `_builds_queued`, `_builds_total{mode,result}`, `_build_duration_seconds` | vaults et constructions |
| `_vault_status{vault,status}`, `_vault_build_progress`, `_vault_lag_seconds`, `_vault_pending_changes`, `_vault_size_bytes`, `_vault_docs`, `_vault_seq` | par vault (les `METRICS_MAX_VAULTS` premiers : en construction, en retard, puis les plus gros) |
| `_changes_total{kind}`, `_docs_indexed_total{origin}`, `_docs_removed_total`, `_docs_skipped_total{reason}`, `_live_units_total{result}` | travail |
| `_backend_requests_total{route,status}`, `_backend_request_latency_seconds` | appels au backend |
| `_errors_total{kind}`, `_shard_restarts_total`, `_evictions_total`, `_vaults_deleted_total{reason}` | incidents |
| `_process_resident_memory_bytes`, `_shard_heap_used_bytes`, `_event_loop_delay_seconds`, `_slot_busy_seconds_total{priority}` | ressources |

Alertes utiles : `ready == 0` plus de 2 min ; `_feed_last_success_age_seconds > 60` ; `_vault_lag_seconds > 30` ; `rate(_rejected_total{reason="overloaded"}[5m]) > 0` (ajouter une instance ou des fils) ; `_call_latency_seconds{quantile="0.95"} > 1`.

### Journal

Une ligne JSON par événement sur la sortie standard (`t`, `level`, `msg`, `svc`, `instance`, `shard`…) : démarrage (configuration, jeton masqué), flux suivi / en rattrapage / indisponible (avec la cause probable : jeton refusé, instance inconnue…), constructions (début, fin, durée), vaults orphelins ou supprimés, appels lents (`SLOW_CALL_MS`), erreurs. Jamais de jeton ni de contenu de note.

### Mode dégradé

- **Backend injoignable** : les index répondent toujours (état `lagging` avec `lagMs`), `ready` passe à faux après `FEED_STALE_MS` ; le flux reprend seul (attente croissante jusqu'à 30 s).
- **Pair arrêté ou tombé** : le backend répond 503 + `Retry-After` ; les clients gardent leur index local et l'affichent. L'édition n'en dépend jamais. Au redémarrage : reprise depuis la position sûre, sans reconstruction.
- **Fil d'indexation tombé** : relancé (attente croissante), ses appels en cours reçoivent 503, le flux est rejoué depuis la position sûre.
- **Fichier d'index abîmé** : supprimé et reconstruit (`_errors_total{kind="corrupt"}`).
- **Surcharge** : 429 `overloaded` (le backend le rend tel quel), `ready` faux tant que la file est presque pleine.
- **Arrêt propre** (SIGTERM) : plus de nouvel appel (503), appels en cours servis, écritures en cours finies, fichiers fermés (WAL reversé), position écrite. Second signal : arrêt immédiat.

## Mesures (29-30/10/2026)

VM ARM Neoverse-N1, **2 vCPU** partagés avec le backend, le générateur de charge et d'autres processus ; Node 24.15 ; une instance, `WORKERS=1` (défaut sur 2 cœurs). Données écrites par de vrais clients SignalR dans une copie du backend : 20 vaults de 2 000 notes + 1 de 10 000 (50 000 notes, 1 à 3 Ko, frontmatter typé, liens, tags). Script : client réel (REST + SignalR + Yjs), toutes les requêtes passent par les routes publiques du backend.

| Mesure | Résultat |
|---|---|
| Construction initiale des 21 vaults (50 000 notes), bridée à 2 vaults à la fois | 126 s (≈ 400 notes/s, lecture au backend comprise) ; mémoire max 454 Mo (RSS) |
| Redémarrage avec index existants | prêt en 3 s, aucune reconstruction ; 115 Mo |
| 16 clients, 30 s, ~50 opérations/s (frappes + lectures), cache actif | |
| — `query.run` (filtre sur 2 propriétés + tri) | p50 24 ms, p95 161 ms |
| — `search.run` (titre, tag) | p50 45 ms, p95 231 ms |
| — `search.run` pire cas (deux mots présents dans toutes les notes) | p50 63 ms, p95 259 ms |
| — `tags.list` / `links.backlinks` | p50 38 ms, p95 191 ms |
| — recherche globale (21 vaults) | p50 146 ms, p95 606 ms |
| — retard de l'index (frappe → trouvée), frappe continue | p50 1,9 s, p95 4,1 s (regroupement : 1 s après la dernière frappe, 5 s au plus) |
| — créneau SQLite occupé | 65 % |
| Note écrite par un client, puis cherchée (bout en bout, au repos) | trouvée en 1,2 à 1,6 s |
| Pair arrêté | routes publiques en 503 + `Retry-After: 5` ; redémarrage : reprise sans reconstruction, note écrite pendant l'arrêt trouvée en 1,3 s |

Saturation : avec des clients sans temps de réflexion (~250 appels/s), le fil unique est occupé à 100 %, la latence monte (p50 300 à 700 ms) et le retard de l'index aussi (les mises à jour passent après les appels, avec un tour garanti sur trois). Remède : `WORKERS` (cœurs) ou une instance de plus. Mesures à deux instances et arrêt brutal d'une instance pendant la charge : non refaites sur cette VM (2 cœurs) ; l'arrêt brutal et la reprise sont couverts par `bundle.test.ts` et l'essai de bout en bout.

## Tests

- `tests/frontend/unit/indexer-tests` (vitest, faux backend `node:http` avec de vrais journaux Yjs) : suivi du flux, regroupement des frappes, renommage, corbeille, suppression, `vault-deleted`, époque, lignes légères, reprise après redémarrage sans reconstruction, arrêt propre, backend coupé, orphelins, reconstruction à côté, fichier abîmé, priorités, 429, cache invalidé, jeton, erreurs, recherche globale, métriques ; et le paquet construit lancé avec deux fils (SIGTERM, puis SIGKILL et reprise). `pnpm test:indexer` depuis `frontend/`.
- CI : `.github/workflows/indexer.yml` (types, paquet, tests, image Docker).
