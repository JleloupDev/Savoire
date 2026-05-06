# POC — Anchor-based Index

## Objectif

Valider les hypothèses techniques du système d'index avant intégration dans Savoire.

---

## Hypothèse centrale à valider

> Deux peers qui créent indépendamment une `Y.RelativePosition` sur le même item CRDT
> produisent un JSON identique → l'ID d'entrée dérivé des anchres est déterministe
> → `add(entry)` est naturellement idempotent.

Si cette hypothèse est fausse, la propriété de convergence de l'index s'effondre.

---

## Architecture testée

```
IndexEntry {
  id        : hash(docId + anchor1 + anchor2)  // déterministe
  value     : "#salut"
  docId     : string
  anchor1   : Y.RelativePosition (JSON) — avant le premier caractère
  anchor2   : Y.RelativePosition (JSON) — après le dernier caractère
}

AnchorIndex {
  entries   : Map<id, IndexEntry>
  docMeta   : Map<docId, { lastValidatedAt: number }>
  revalidationQueue : Set<docId>
}

Ops :
  add(entry)    — idempotent si même id
  remove(id)    — idempotent
```

---

## Scénarios de test

### S1 — Déterminisme des anchres (hypothèse centrale)

```
Setup : un Y.Doc avec Y.Text "hello #salut world"
        deux instances distinctes du même doc (simulant deux peers)

Peer A : crée anchor1, anchor2 autour de "#salut" → id_A
Peer B : crée anchor1, anchor2 autour de "#salut" → id_B

Assert : id_A === id_B
```

**Ce que ça valide :** les `add` concurrents du même peer sont idempotents.

---

### S2 — Résolution après insertion avant le token

```
Setup : Y.Text "hello #salut world"
        anchres créées autour de "#salut"

Action : insérer "XXXX " avant "#salut"
         → Y.Text devient "hello XXXX #salut world"

Assert : résoudre anchor1 et anchor2 dans le Y.Text modifié
         → le texte entre les positions absolues est toujours "#salut"
```

**Ce que ça valide :** les anchres survivent aux insertions à gauche.

---

### S3 — Résolution après insertion à l'intérieur du token

```
Setup : Y.Text "hello #salut world"
        anchres créées autour de "#salut"

Action : insérer "X" à l'intérieur → "#saXlut"

Assert : résoudre anchor1 et anchor2
         → le texte entre les positions n'est plus "#salut"
         → l'entrée doit être supprimée (remove)
         → scanner la plage → créer une nouvelle entrée pour "#saXlut" si valide
```

**Ce que ça valide :** la détection d'invalidation et la re-création d'entrée.

---

### S4 — Suppression du token

```
Setup : Y.Text "hello #salut world"
        anchres créées autour de "#salut"

Action : supprimer "#salut"

Assert : résoudre anchor1 → position indéterminée ou confondue avec anchor2
         → l'entrée est invalide → remove(id)
         → l'index ne contient plus d'entrée pour "#salut" dans ce doc
```

**Ce que ça valide :** la détection de suppression.

---

### S5 — Convergence P2P (deux peers, éditions concurrentes)

```
Setup : Y.Doc partagé entre Peer A et Peer B (via Y.encodeStateAsUpdate / applyUpdate)
        Y.Text initial : "hello world"

Peer A (offline) : tape "#salut " → met à jour son index local
Peer B (offline) : tape "#todo "   → met à jour son index local

Sync : Peer A reçoit l'update de B, Peer B reçoit l'update de A

Assert après sync :
  - les deux peers ont le même Y.Text (ordre déterminé par Yjs)
  - Peer A valide les anchres de B → entrée "#todo" confirmée
  - Peer B valide les anchres de A → entrée "#salut" confirmée
  - l'index des deux peers est identique
```

**Ce que ça valide :** convergence de l'index après merge offline.

---

### S6 — Détection de revalidation nécessaire (staleness)

```
Setup : index avec une entrée pour doc1 (lastValidatedAt = T0)

Action : recevoir un vault snapshot avec doc1.updatedAt = T1 > T0
         et doc1 n'est pas ouvert

Assert : doc1 est ajouté à revalidationQueue
         (pas de résolution d'anchre ici — juste le flag)
```

**Ce que ça valide :** la détection des docs potentiellement stale à la reconnexion.

---

## Ce que le POC ne teste PAS

- L'intégration avec SignalR / le serveur
- La persistance de l'index (stockage)
- L'UI
- Les plugins réels (hashtags utilisés comme exemple uniquement)

---

## Résultat attendu

Tous les scénarios passent → on peut passer à l'intégration réelle dans Savoire.

Si S1 échoue → revoir la stratégie d'ID (UUID random + déduplication par (docId, anchor) comme clé composite).
Si S3/S4 échouent → revoir la stratégie d'invalidation (GC Yjs, anchres tombées).
