<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- SPDX-FileCopyrightText: 2026 Jean Leloup -->
# @savoire/indexer-core

Le noyau d'indexation partagé (ADR-027, étape 2). Il transforme les documents d'un vault en un index SQLite **dérivé** : jamais synchronisé, toujours reconstructible depuis les CRDT. Le même code tourne :

- dans le **pair indexeur** (Node, `apps/indexer`, étape suivante) ;
- dans le **navigateur** (SQLite WebAssembly dans un Worker, à venir) ;
- sur le **bureau** (SQLite natif via Tauri, à venir).

Le cœur n'utilise ni le DOM ni d'API Node (vérifié par un test). Dépendances : `@savoire/plugin-api`, `@savoire/domain-index`, `yjs`. Aucune dépendance npm nouvelle.

Contrat technique : `docs/Architecture/indexer-protocol.md`. Contrats de l'appli : `packages/plugin-api/src/query.ts` (`IQueryEngine`), `search.ts` (`ISearchEngine`).

## Utilisation

```ts
import { VaultIndex, vaultTreeFromUpdates, noteInputFromUpdates, diffTree } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'

const index = await VaultIndex.open(NodeSqliteDriver.open(`${dataDir}/${vaultId}.sqlite`))
if (index.rebuildRequired) {
  // Construction complete : l'arbre du vault, puis chaque note (par lots).
  const tree = vaultTreeFromUpdates(treeUpdates)            // journal Yjs (base 64) de l'arbre
  for (const [id, path] of tree.docs) {
    const input = noteInputFromUpdates(id, path, await fetchDoc(id))  // null : type non indexe
    if (input) batch.push(input)                            // puis index.applyDocs(batch, { seq })
  }
  await index.markBuilt()
}
// Au fil de l'eau : une note = une transaction, sequence comprise.
await index.applyDoc(input, { seq })
await index.removeDoc(id, { seq })
await index.moveDoc(id, newPath, { seq })     // 'missing' : relire le document
// Appel du protocole (relaye par le backend) :
await index.call('links', 'backlinks', { id })
// Contrats de l'appli :
index.queryEngine().watch(query, cb)
index.searchEngine().search({ text: 'reseau "mot exact"' })
```

- `applyDoc` / `applyDocs` : `{ id, path, content }` (Markdown) ; une note de la corbeille (`.trash/`) est retirée, jamais indexée.
- `applyRecords` : notes déjà lues (`extractNote`, `makeRecord`), et **lignes légères** d'une base (`makeRecord({ id, base, path: '', title, props })`) : la source `{ base }` des requêtes les lit. La lecture des lots de lignes dans les CRDT n'est pas faite ici.
- `moveDoc` : déplacement sans relire le contenu (le titre tiré du nom suit, les liens sont résolus à nouveau). Rend `'missing'` si l'hôte doit relire le document (sortie de corbeille, changement d'extension).
- `paths()` + `diffTree(indexé, arbre)` : ce qui a changé dans l'arbre du vault.
- `setState({ status: 'building', progress })` : état rendu avec chaque résultat.
- Les opérations s'exécutent une à une, dans l'ordre des appels (un seul écrivain par vault).

## Pilotes

`SqlDriver` (`src/driver.ts`) est **asynchrone** : `exec(sql)`, `all(sql, params)`, `batch(statements)` (une transaction, tout ou rien), `close()`. Pas de booléen (0 / 1).

| Pilote | Où | État |
|---|---|---|
| `NodeSqliteDriver` | `@savoire/indexer-core/node` (`node:sqlite`, Node 22.5+, SQLite 3.51 dans Node 24) | livré : WAL hors mémoire, `synchronous=NORMAL`, `busy_timeout`, cache d'instructions préparées |
| WebAssembly (Worker, OPFS) | navigateur | à faire (`@sqlite.org/sqlite-wasm`, à valider) |
| natif (Tauri) | bureau | à faire (`rusqlite`, à valider) |

Prérequis d'un pilote : FTS5 avec `contentless_delete` (SQLite 3.43+), JSON1 (`json_each`), `UPDATE` avec sous-requêtes corrélées.

## Schéma

Versionné. L'index étant dérivé, **pas de migration en place** : une version différente du noyau (`CORE_VERSION`) vide toute la base ; une version différente d'un pouvoir (ou un pouvoir nouveau) vide ses tables. Dans les deux cas : `rebuildRequired`, séquence remise à 0. Un pouvoir retiré voit ses tables supprimées.

| Table | À qui | Contenu |
|---|---|---|
| `meta` | noyau | `core` (version), `power:<nom>` (version et tables), `seq` (dernière séquence traitée), `built` |
| `docs` | noyau | une ligne par note ou ligne légère (`n` = clé interne) : chemin, titre, dossier, extension, dates (brutes et repliées, NULL si vides), clés de liens, propriétés en JSON |
| `props` | `query` | une ligne par valeur (par élément d'une liste) : `txt` repliée par `foldText` (en JS), `num`, `val` (JSON exact, pour les groupes) ; index `(key, txt)` et `(key, num)` |
| `search_fts` | `search` | FTS5 sans contenu (`contentless_delete`), `unicode61 remove_diacritics 2`, colonnes `title`, `body`, `props` (mots déjà repliés en JS) |
| `search_text` | `search` | sections de chaque note (titre, texte) pour les extraits |
| `links`, `aliases` | `links` | liens (cible écrite, clés, cible résolue `dst`), alias |
| `tags` | `tags` | un tag par note (clé en minuscules) |

## Pouvoirs

| Capacité | Méthodes |
|---|---|
| `query` | `run` : `IQueryEngine` sur SQL. Requête compilée en SQL **paramétré** (noms de propriétés compris). Passe `describeQueryEngineContract` à l'identique du moteur en mémoire, lignes légères de base comprises. |
| `search` | `run` : `ISearchEngine` sur FTS5. Texte tapé réduit à des mots et des suites exactes (jamais de syntaxe FTS5), bm25 (titre 10, propriétés 3, texte 1), 3 extraits au plus avec surlignage et titre de section. Passe `describeSearchEngineContract`. |
| `links` | `backlinks`, `outgoing`, `unresolved`, `graph` ; résolution façon Obsidian faite en SQL dans la transaction de la note. |
| `tags` | `list`, `notes` |
| `index` | `status` |

### Ajouter un pouvoir

1. Un module dans `src/powers/` qui exporte un `IndexPower` (`src/power.ts`) :
   - `name` (la capacité du protocole) et `version` ;
   - `tables` et `schema` (`CREATE ... IF NOT EXISTS`) ;
   - `write(ctx, doc, note)` : instructions tirées d'un `NoteRecord` (peut être asynchrone, pour des vecteurs calculés par exemple), `remove`, `afterRemove`, `move` au besoin ;
   - `methods` : `{ parse(params), run(ctx, params) }` ; `parse` vérifie tout (le JSON vient du réseau) ;
   - `ingest(ctx, données)` pour ce qui ne vient pas d'une note (texte des pièces jointes...), appelé par `VaultIndex.ingest(nom, données)` ;
   - `api` : ce qu'il offre aux autres pouvoirs (`ctx.api(nom)`), comme `search` offre son filtre plein texte à `query`.
2. L'inscrire dans `defaultPowers()` (`src/powers/index.ts`).
3. Ajouter ses lignes au tableau des pouvoirs de `indexer-protocol.md`. Le backend n'a rien à changer.

## Extraction

`extractNote({ id, path, content })` (pure) : propriétés (`parseFrontmatter` de domain-index, types forcés par un `PropertySchema` avec `coercePropertyValue`), titre (`title` du frontmatter, sinon premier H1, sinon **nom du fichier** : une ligne a toujours un titre lisible), texte brut sans Markdown par sections, liens (`[[x]]`, `[[x|alias]]`, `[[x#titre]]`, `![[x]]`, `[t](note.md)`), tags (frontmatter et `#tag` hors code, imbriqués `a/b`), alias, dossier, extension.

`readDocContent(path, ydoc)` rend le contenu indexable selon le type : `.md` et `.outline` (texte `codemirror`), `.page` (arbre partagé `tree/doc`, rendu en Markdown), `.excalidraw` (textes visibles), `.mindmap` (sujets en liste imbriquée) ; autres : `null`. L'arbre du vault (`readVaultTree`) suit le schéma de `YMapVaultDirectory` (cartes `vault` et `folders`) ; les tests écrivent les documents avec le code des clients.

## Banc d'essai

`tests/frontend/unit/indexer-core-tests` : `pnpm bench` (ou `npx vitest run --config vitest.bench.config.ts`). Réglages : `BENCH_NOTES`, `BENCH_ROWS`, `BENCH_KEEP=1`. Vault généré à graine fixe : 10 000 notes, 1 à 3 Ko de texte (vocabulaire de Zipf), frontmatter typé, liens, tags ; puis une base de 100 000 lignes légères. Fichier SQLite sur disque, WAL.

Mesures du 28/10/2026 (VM ARM Neoverse-N1, 2 vCPU, 11 Go, partagée avec d'autres processus ; Node 24.15, SQLite 3.51) :

| Mesure | Résultat |
|---|---|
| Extraction seule | 0,12 ms par note |
| Construction complète, 10 000 notes (23,5 Mo de texte), lots de 200 | 13,5 à 15 s (environ 700 notes/s) |
| Mise à jour d'une note (une transaction) | 4 à 5 ms |
| Requête filtrée (statut, priorité) triée (échéance), 1 247 résultats, page de 50 | 5 à 9 ms ; page suivante 5 à 6 ms |
| Tri seul de toutes les notes | 10 à 11 ms |
| `groupBy` statut / tags (toutes les notes) | 12 ms / 17 ms |
| Recherche plein texte (1 000 à 6 500 notes trouvées) | 16 à 26 ms |
| Recherche d'un mot présent partout (« le », 10 000 notes) | 76 ms |
| Suite exacte (34 notes) | 10 ms |
| Rétroliens d'une note | 0,1 ms |
| Liens non résolus / liste des tags / graphe (2 000 nœuds) | 14 ms / 16 ms / 90 ms |
| Taille du fichier (10 000 notes) | 68 Mo |
| Base de 100 000 lignes légères : chargement | 18 à 20 s |
| — filtre + tri (9 888 lignes), page de 50 ; page suivante | 53 à 74 ms ; 54 à 85 ms |
| — tri seul des 100 000 lignes / `groupBy` | 81 à 97 ms / 110 ms |
| — modification d'une ligne | 1,2 ms |
| — taille du fichier | 60 Mo |

## Limites connues

- Mélange de nombres et de textes dans une même propriété : SQLite range les nombres avant les textes (le moteur en mémoire compare alors en texte, sans ordre total). Identique dès que la colonne est homogène.
- Ordre des textes : octets UTF-8 (SQLite) contre unités UTF-16 (JS) ; seuls diffèrent les caractères hors du plan multilingue de base face à ceux de U+E000 à U+FFFF.
- `remove_diacritics 2` replie aussi des lettres que `foldText` garde (ø, ł, đ) : la recherche en trouve un peu plus que le moteur en mémoire.
- `groups` : 1 000 groupes au plus (les plus nombreux).
- Tri sur 100 000 lignes : lecture d'une valeur par ligne (pas d'index de tri) ; pour aller plus loin, des tables larges par base, plus tard.
