# plugin-bible

Choisir sa Bible, la télécharger dans le vault, puis la citer dans une note.
Ancien « QuickRef » (version Savoire du plugin Obsidian QuickRefTS) : un vault
qui avait installé QuickRef garde le plugin sous son nouveau nom.

## Choisir et télécharger

Panneau **Bible** (commande « Bible : choisir et télécharger une Bible », ou le
bouton 📖 de la barre de l'éditeur) : la Bible du dossier `Bible/`, la liste
des Bibles proposées et le téléchargement, avec son avancement.

| Bible | Source |
| --- | --- |
| Traduction du monde nouveau (révision 2018) | wol.jw.org, chapitre par chapitre |

- **Application bureau seulement** : un navigateur ne peut pas lire wol.jw.org
  (pas d'en-tête CORS). La page passe par la commande native `web_fetch_text`
  (`curl` du système, liste fermée de sites : voir
  `apps/desktop/src-tauri/src/web_fetch.rs`).
- **Sur le web** : la même Bible s'installe depuis le Savoire Store (paquet de
  notes `bible-tmn-fr`).
- Une note qui existe déjà est gardée : une installation arrêtée reprend là où
  elle s'est arrêtée, et des notes faites à la main ne sont pas remplacées.

Ajouter une Bible : une entrée dans `src/bibles.ts` (adresse d'un chapitre et
découpage de la page). Les notes ont toujours le même format (`src/notes.ts`).

## Les notes

```
Bible/Bible.md                  index : la Bible installée (bible: tmn-fr)
Bible/01 - Genèse/Genèse.md     livre : tag Bible/Book, alias, chapitres
Bible/01 - Genèse/Genèse 1.md   chapitre : tag Bible/Chapter, versets
```

Un verset est un bloc : ses lignes en italique (une par vers en poésie), puis
la référence marquée `^numéro`.

## Citer

| Saisie | Résultat |
| --- | --- |
| `!gen` | chapitres dont le nom ou un alias contient « gen » |
| `!Gen 1:` | tous les versets du chapitre |
| `!Gen 1:3-5`, `!Héb 12:3,7,8` | ces versets |
| `!Gen 1:lumière` | versets du chapitre qui contiennent ce mot |
| `!grâce` | ce mot dans toute la Bible (40 résultats au plus) |

Entrée insère les intégrations `![[Genèse 1#^3]]`, une par verset.

Commandes (aussi dans le bouton 📖 de la barre de l'éditeur) :

- **Ctrl+Maj+B** : la référence sélectionnée (« Ps. 139:17 ; Marc 8:33 ») →
  ses versets sous la ligne ;
- **tout le document** : les références entre parenthèses de chaque ligne →
  leurs versets sous la ligne. Une ligne déjà suivie de ses versets n'est pas
  refaite.

Réglages fixes pour l'instant (pas encore de réglages par plugin) : dossier
`Bible/`, déclencheur `!`, séparateur `:`.

## Paquet du store

`scripts/build-notes-package.ts` fabrique les pièces jointes d'une release
(`manifest.json`, `notes.zip`) avec le même code que le plugin :

```bash
cd packages/plugins/plugin-bible
node --experimental-strip-types --import ./scripts/ts-resolve.mjs \
  scripts/build-notes-package.ts --out ~/savoire-packages/bible-tmn-fr --version 1.0.0
```

Sortie hors du dépôt : le texte de la Bible n'y entre jamais.
