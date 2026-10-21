# Format d'un vault sur disque (version bureau)

Un vault sur disque est rangé **comme dans Obsidian** : un dossier ordinaire.
Les notes sont des `.md` en texte clair, les images sont des fichiers
ordinaires. Tout reste lisible et modifiable par d'autres outils (éditeur,
Git, gestionnaire de fichiers, Obsidian).

Ce que le texte ne sait pas porter vit dans un dossier caché `.savoire/` à la
racine.

Code : `packages/infrastructure-sync/src/filesystem/` (`FileSystemVaultSession`,
`vaultFolderFormat.ts`). Port du disque : `IVaultFileSystem`
(`packages/platform/src/fileSystem.ts`).

## Arborescence

```
Mon vault/
├── Accueil.md                 note : texte clair
├── Projet.md
├── Projet/                    dossier de la note Projet.md
│   └── Capture.png            image rangée avec sa note, sous son nom
├── Dessin.excalidraw          document non textuel (voir plus bas)
├── .trash/                    corbeille, comme Obsidian
│   └── Ancien/Note.md         chemin d'origine conservé
├── .obsidian/                 ignoré (comme tout dossier caché)
└── .savoire/
    ├── vault.json             id du vault, nom, version du format
    ├── documents.json         id stable de chaque fichier, dossiers créés exprès
    ├── crdt/<id>/             état Yjs d'un document CRDT
    │   ├── <date>-<session>-<n>.update   lots de modifications
    │   ├── <date>-<session>-<n>.state    état compacté
    │   └── projected.json     empreintes des dernières écritures du .md
    ├── maps/<nom>/            index, réglages, cartes partagées (même forme)
    ├── snapshots/<id>.json    qui a écrit en dernier un document snapshot
    └── detached/<id>          contenu d'un document sans chemin (en transit)
```

Les noms sous `.savoire/` encodent les ids : tout caractère hors
`[A-Za-z0-9_-]` devient `~xxxx` (code hexadécimal).

## Qui est la vérité

| Donnée | Vérité | Détail |
|---|---|---|
| Liste des documents et dossiers | les fichiers du dossier | `documents.json` ne garde que les ids |
| Note `.md` (et `.txt`, `.outline`) | l'état Yjs dans `crdt/<id>/` | projeté dans le `.md` après un court délai |
| Page, Excalidraw, carte mentale, chat | l'état Yjs seul | le fichier visible n'est jamais réécrit (voir plus bas) |
| Document snapshot (tableau...) | le fichier lui-même | dernier écrivain gagne |
| Image, pièce jointe | le fichier lui-même | à son chemin lisible, pas sous un id |
| Index, réglages, cartes partagées | `maps/<nom>/` | état Yjs |

**Documents CRDT non textuels.** Aucun export lisible générique n'existe
aujourd'hui (les `contentExtractor` lisent l'ancien format, ils n'en
écrivent pas). Le fichier visible garde donc son contenu d'origine : un
`.excalidraw` venu d'ailleurs reste lisible, et le plugin le lit par le canal
snapshot pour sa migration. Un document créé dans l'application a un fichier
visible vide. Un export lisible pourra venir plus tard, fourni par le plugin.

## Modifications faites hors de l'application

La session surveille le dossier (`watch`). Sans surveillance, l'application
appelle `refresh()` quand elle reprend la main.

- **Un `.md` modifié ailleurs** est relu et appliqué au texte CRDT par un
  **diff minimal** (lignes, puis caractères) : le reste du texte garde son
  identité (curseurs, fusion). Le diff part du **dernier accord** entre le
  fichier et l'état : une frappe locale pas encore écrite est fusionnée, pas
  effacée.
- **Pas de boucle.** Après notre propre écriture, le fichier relu est égal au
  dernier accord : rien ne se passe. Une projection périmée (écrite par une
  autre fenêtre, ou interrompue par un arrêt brutal) est reconnue par son
  empreinte dans `projected.json` et réécrite depuis l'état, jamais lue comme
  une modification.
- **Modifié pendant que l'application était fermée** : relu de la même façon à
  l'ouverture du document.
- **Fichier nouveau** : il entre au répertoire avec un id tiré de son chemin
  (deux fenêtres qui le découvrent lui donnent le même id). Une note sans état
  prend un premier état Yjs tiré de son texte, de façon déterministe : deux
  fenêtres qui ouvrent la même note n'en doublent pas le texte.

## Renommages

- **Dans l'application** : le fichier est déplacé ; l'id ne change pas. On
  n'écrase jamais un fichier : si la cible existe, elle prend un suffixe
  (« Note 1.md »).
- **Hors de l'application** : une disparition et une apparition sont
  rapprochées. Même taille et même date de modification (un renommage garde
  la date) : c'est le même document, il garde son id et son historique. À
  défaut, même contenu (empreinte connue des textes). Sinon (contenu changé
  en même temps, ou plusieurs candidats) : nouveau document, l'ancien quitte
  le répertoire.

## Corbeille

Comme Obsidian : `.trash/` à la racine. Mettre à la corbeille déplace le
fichier sous `.trash/<chemin d'origine>`. Restaurer le ramène. Supprimer
définitivement efface le fichier et son état dans `.savoire/`.

Un dossier vidé par le départ de son dernier fichier quitte le disque, sauf
s'il a été créé exprès dans l'application (liste `folders` de
`documents.json`). Un dossier qui contient encore un fichier inconnu de
l'application n'est jamais effacé.

## Compatibilité Obsidian

Ouvrir un vault Obsidian (un dossier de `.md` sans `.savoire/`) le
transforme en vault Savoire **sans réécrire aucune note** : seul `.savoire/`
est créé. Les dossiers et fichiers cachés (`.obsidian/`, `.git/`,
`.DS_Store`...) sont ignorés, sauf `.trash/`. Les liens `[[...]]` et
`![[...]]` se résolvent comme dans Obsidian (`attachments.ts`).

## Plusieurs fenêtres sur le même dossier

Elles se voient par la surveillance du disque. Les mises à jour CRDT sont
des fichiers ajoutés, jamais réécrits : aucune fenêtre n'écrase l'autre. La
compaction n'efface que des fichiers déjà lus. Limite : une modification
externe vue au même instant par deux fenêtres dont l'état diffère peut être
appliquée deux fois. Une seule fenêtre par vault reste le cas conseillé.

Pas de verrous ni de partage : un seul utilisateur local. La présence
(curseurs des autres) ne va nulle part.

## Versionnage du format

`vault.json` porte `format` (aujourd'hui `1`, `VAULT_FORMAT_VERSION`). Une
version qui trouve un format plus récent refuse d'ouvrir le dossier
(`UnsupportedVaultFormatError`) plutôt que de risquer de l'abîmer. Un
changement de format incrémente ce numéro et fournit sa migration à
l'ouverture.

## Limites connues

- Les états des documents effacés hors de l'application restent dans
  `.savoire/crdt/` (pas encore de ménage).
- Un renommage externe accompagné d'une modification du contenu donne un
  nouveau document.
- Le diff fin s'arrête au-delà de 500 lignes changées ; il remplace alors le
  bloc changé d'un seul tenant.
