# API CRDT des plugins

Un plugin peut faire éditer un document par plusieurs membres en même temps,
sans perte. Il le fait par trois contrats de `@savoire/plugin-api`. Aucun
n'expose de bibliothèque CRDT.

## Les trois briques

| Contrat | Où le trouver | À quoi il sert |
|---|---|---|
| `ISharedMap` | `ctx.shared.openMap(nom)` | Une carte clé -> valeur propre au document. Deux clés différentes ne s'écrasent jamais ; sur la même clé, le dernier gagne. Un élément (message, forme, ligne) par clé. |
| `ISharedText` | `ctx.text` | Le texte brut du document. Les écritures concurrentes fusionnent caractère par caractère. |
| `ISharedTree` | `ctx.tree` | Le document vu comme un arbre JSON : cartes, listes, textes riches, éléments. Pour une page en arbre ProseMirror, un tableau structuré... |

`ctx.text` et `ctx.tree` n'existent que pour un type déclaré
`collaborationMode: 'crdt'`, et seulement quand le document est synchronisé.
Un plugin doit supporter leur absence (par exemple en retombant sur
`ctx.vault`).

`text` et `tree` sont deux racines du **même** document CRDT. Un plugin
choisit l'une **ou** l'autre pour son contenu : elles ne se voient pas.

## Les deltas

Un changement de texte est un **delta** : une suite d'opérations qui parcourt
le texte du début à la fin.

```ts
[{ retain: 5 }, { delete: 2 }, { insert: 'abc' }]
// garder 5 caractères, en supprimer 2, insérer « abc »
```

Les positions comptent en unités UTF-16, comme `String.length`.

```ts
const text = ctx.text
text.insert(0, 'Titre\n')
text.applyDelta([{ retain: 6 }, { insert: '- point\n' }]) // une seule modification
const stop = text.onChange((delta, origin) => { /* ... */ })
```

Dans l'arbre, le texte est **riche** : un `insert` ou un `retain` peut porter
des `attributes` (les marques : `{ bold: true }`, `{ link: { href } }`). Dans
un `retain`, une valeur `null` retire l'attribut. Un texte inséré sans
attributs n'a aucun format : il n'hérite pas de ses voisins.

## L'origine

Chaque changement arrive avec son origine :

- `'local'` : il vient de ce client. Par ce plugin, ou par une autre vue du
  même document dans le même onglet.
- `'remote'` : il vient d'un autre membre.

Un plugin qui a déjà mis sa vue à jour avant d'écrire peut ignorer ses
propres changements `'local'`. Il doit appliquer tous les `'remote'`.

## Règle : l'état initial arrive en distant

Le texte et l'arbre sont **vides à l'ouverture**. Le contenu déjà connu
arrive juste après, en changements `'remote'`. C'est la règle du port de
synchro (`IVaultSyncSession.openDocument`), la même pour tous les profils :
serveur, pair à pair local, EdgeSync.

Donc, à l'ouverture de la vue :

1. lire l'état courant (`text.toString()`, `tree.root`), souvent vide ;
2. s'abonner (`onChange`) ;
3. appliquer chaque changement reçu, y compris le premier, qui porte le
   contenu.

Ne pas attendre « le chargement » : aucun événement ne signale la fin. Le
contenu arrive comme une modification ordinaire.

## Un document neuf est vide

Le contenu rendu par `FileTypeSpec.create()` n'est pas écrit pour un type
`'crdt'` : l'état d'un tel document n'existe que par ses opérations, et une
écriture en bloc ne passerait ni par la synchro ni par les pairs. La vue pose
la structure de départ elle-même, à la première modification de la personne
(jamais à l'ouverture : deux membres qui ouvrent en même temps créeraient
deux structures concurrentes).

## L'arbre partagé (`ISharedTree`)

### Les nœuds

| Sorte | Contrat | Contenu |
|---|---|---|
| carte | `ITreeMap` | clé -> valeur |
| liste | `ITreeList` | valeurs ordonnées |
| texte | `ITreeText` | texte riche (attributs de format sur des plages) |
| élément | `ITreeElement` | nom fixe + attributs + enfants ordonnés (éléments ou textes) |

Les valeurs d'une carte ou d'une liste sont des primitives (`null`, booléen,
nombre, chaîne) ou des nœuds. Un objet JSON se range dans une carte, ou dans
une chaîne s'il se remplace en bloc. Les attributs d'un élément acceptent
n'importe quelle valeur JSON.

La racine `tree.root` est une carte. Un plugin y range son contenu sous une
clé de son choix. On crée un nœud en l'insérant, à partir d'une description :

```ts
const doc = ctx.tree.root.set('doc', {
  kind: 'element', name: 'doc', children: [
    { kind: 'element', name: 'paragraph', children: [
      { kind: 'text', delta: [{ insert: 'du ' }, { insert: 'gras', attributes: { bold: true } }] },
    ] },
  ],
}) as ITreeElement
```

Un document ProseMirror s'écrit ainsi directement : un nœud ProseMirror
devient un élément (`type` -> `name`, `attrs` -> attributs), et une suite de
nœuds texte devient un texte riche dont les marques sont des attributs de
format.

### L'identité

- `node.id` est stable toute la vie du nœud, et **le même chez tous les
  membres**.
- La poignée aussi est stable : le même nœud rend toujours le même objet
  (`===`). On peut s'en servir comme clé de `Map`.
- Il n'y a pas de déplacement : déplacer, c'est supprimer puis réinsérer, et
  cela crée un **nouveau** nœud. Ni Yjs ni Automerge ne savent déplacer sans
  risque en concurrence.
- `node.deleted` passe à `true` quand le nœud quitte l'arbre.

### Les changements

`node.observe(cb)` reçoit les changements de ce nœud. `node.observeDeep(cb)`
et `tree.onChange(cb)` reçoivent ceux de tout le sous-arbre, par lot.

| Sorte | Changement |
|---|---|
| carte | `keys` : clés changées. Lire les nouvelles valeurs dans `target`. |
| liste | `delta` : `retain` / `insert` (les nœuds déjà en place) / `delete` |
| texte | `delta` : delta de texte riche |
| élément | `attributes` : noms changés ; `children` : delta des enfants |

Les règles :

- un lot par transaction, livré **après** elle ;
- dans un lot, on applique les changements dans l'ordre ; un delta
  s'exprime par rapport à l'état du nœud juste avant ce changement ;
- un nœud créé dans la transaction n'a pas de changement propre : il
  apparaît dans le delta de son parent, dans son état de fin de lot ;
- un changement peut viser un nœud supprimé dans le même lot
  (`target.deleted`) : on l'ignore.

### Transactions et étiquette

`tree.transact(fn, tag)` groupe des écritures : les membres et les abonnés
les voient comme **une** modification. L'étiquette revient dans `info.tag`
des changements **locaux** de ce lot. C'est l'outil anti-écho : un plugin
qui reflète un autre modèle écrit sous son étiquette, et ignore les lots qui
la portent.

## Une bibliothèque qui ne parle que Yjs

Certaines bibliothèques d'édition (y-prosemirror pour Tiptap, y-codemirror...)
veulent un `Y.Doc`. Le plugin n'en reçoit pas. Il fait un **adaptateur
interne** : un `Y.Doc` privé, local au plugin, relié au contrat.

Pour un texte brut (`ctx.text`) :

```ts
const doc = new Y.Doc()
const ytext = doc.getText('t')
const FROM_SAVOIRE = Symbol('savoire')
let writing = false

// État de départ, puis tout ce qui arrive de Savoire.
ytext.insert(0, ctx.text.toString())
ctx.text.onChange((delta) => {
  if (writing) return // notre propre écriture, déjà dans ytext
  doc.transact(() => applyDeltaToYText(ytext, delta), FROM_SAVOIRE)
})

// Ce que tape la personne, vers Savoire.
ytext.observe((event) => {
  if (event.transaction.origin === FROM_SAVOIRE) return
  writing = true
  try { ctx.text.applyDelta(toSavoireDelta(event.delta)) } // sans les attributs
  finally { writing = false }
})
```

Pour un arbre (Tiptap + y-prosemirror sur `ctx.tree`), le principe est le
même, nœud pour nœud :

- deux tables d'identité : `ITreeElement`/`ITreeText` <-> `Y.XmlElement`/`Y.XmlText` ;
- au départ, recopier `tree.root.get('doc')` dans le `Y.XmlFragment` privé ;
- **Savoire -> Y.Doc** : `tree.onChange`, ignorer les lots où
  `info.tag === MON_TAG` ; pour chaque changement, retrouver le type Yjs par
  la table et y appliquer le delta (enfants, attributs, texte) dans
  `doc.transact(..., FROM_SAVOIRE)` ; ajouter les nœuds insérés aux tables ;
- **Y.Doc -> Savoire** : `fragment.observeDeep`, ignorer les transactions
  d'origine `FROM_SAVOIRE` ; traduire chaque événement Yjs vers le nœud
  correspondant, le tout dans `tree.transact(..., MON_TAG)`.

Les deltas sont de même forme des deux côtés (retain/insert/delete,
attributs de format) : la traduction reste mécanique.

Yjs devient alors une dépendance **du plugin**, pas de l'API. La fusion reste
faite par la session ; le `Y.Doc` privé n'est qu'une copie de travail.

## Ce qui n'existe pas encore

- **Déplacement** de nœuds (voir plus haut) : supprimer puis réinsérer.
- **Historique** : pas d'annuler/refaire partagé, pas de versions, pas
  d'attribution par auteur.
- **Attributs de format dans `ISharedText`** : le texte brut n'en a pas. Le
  texte riche existe dans l'arbre.
- **Présence** (curseurs des autres) pour une vue de plugin.
- **Indexation de l'arbre** : la recherche et les liens lisent le texte
  (`'codemirror'`), pas l'arbre. Un plugin qui stocke en arbre fournit son
  texte à indexer par `contentExtractor` / `onContentStabilized`.

## Pourquoi Yjs n'est jamais exposé

- **Backend interchangeable.** La synchro passe par un port
  (`IVaultSyncSession`) avec plusieurs profils. Un futur profil peut reposer
  sur Automerge ou autre chose. Un plugin qui recevrait un `Y.Text`
  casserait ce jour-là. Les sortes de nœuds de l'arbre existent dans les deux
  (Automerge : cartes, listes, texte avec marques ; un élément y devient une
  carte `{ nom, attributs, enfants }`).
- **Portabilité pair à pair.** Le même plugin doit marcher avec le serveur,
  sans serveur, et en EdgeSync. Le contrat ne suppose rien du transport.
- **Surface petite.** Quelques méthodes et des deltas, faciles à implémenter
  pour un nouveau profil et à simuler en test : `InMemorySharedText` et
  `InMemorySharedTree` de `@savoire/plugin-runtime`, avec `link(a, b)` pour
  deux membres.

## Côté implémentation

- Contrats : `packages/plugin-api/src/sharedText.ts`, `sharedTree.ts`,
  `sharedMap.ts`.
- Port : `IVaultSyncSession.openText(docId)`, `openTree(docId)` et
  `openSharedMap(nom)` (`packages/application/src/contracts.ts`).
- Adaptateurs Yjs, seule couche qui connaît Yjs :
  `packages/infrastructure-sync/src/YjsSharedText.ts` et `YjsSharedTree.ts`.
  L'arbre est la `Y.Map` `'tree'` du `Y.Doc` du document : carte -> `Y.Map`,
  liste -> `Y.Array`, texte -> `Y.Text` (ou `Y.XmlText` sous un élément),
  élément -> `Y.XmlElement`. Ce dernier est le modèle exact de
  y-prosemirror : un plugin Tiptap traduit nœud pour nœud, sans changer de
  forme.
- Branchement : `DocumentView` donne `ctx.text` et `ctx.tree` à un type
  `'crdt'`.
- Tests : contrat commun `vaultSyncSessionContract.ts` (sections « texte
  partagé » et « arbre partagé »), comportement commun de l'arbre
  `contract/sharedTreeBehaviour.ts` (mémoire et Yjs), fusion concurrente dans
  `YjsSharedTree.test.ts`.
