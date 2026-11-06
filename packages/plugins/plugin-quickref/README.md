# plugin-quickref

Citer la Bible dans une note : version Savoire du plugin Obsidian QuickRefTS.

Le plugin lit les notes du dossier `Bible/` : chapitres (tag `Bible/Chapter`),
livres (tag `Bible/Book`), leurs alias, et les versets marqués `^numéro` en fin
de bloc.

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
