<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- SPDX-FileCopyrightText: 2026 Jean Leloup -->
# plugin-outline — Plans

Des plans à la Workflowy dans des fichiers `.outline`.

Comportements inspirés d'obsidian-outliner, de Viacheslav Slinko, MIT
(<https://github.com/vslinko/obsidian-outliner>). Le code est écrit pour
Savoire : seuls les comportements sont repris, pas le code.

## Format

Un `.outline` est une liste Markdown imbriquée, lisible dans n'importe quel
éditeur :

```markdown
- Projet
  - [ ] Écrire le brouillon
  - Notes
    - une idée
```

Deux espaces par niveau. Le pliage et le zoom ne sont pas écrits dans le
fichier : ils restent propres à la vue.

## Édition

Entrer dans un élément est l'action centrale : clic sur sa puce. Il devient
le titre de la page, ses enfants la liste en dessous ; le fil d'Ariane en
haut (ou Échap) permet de remonter.

| Action | Touche par défaut | Commande |
| --- | --- | --- |
| Nouvel élément (enfant si l'élément a des enfants dépliés) ; élément vide : le remonter | Entrée | `outline:new-item` |
| Au début d'un élément : le joindre au précédent (vide : le supprimer) | Retour arrière | `outline:delete-empty-item` |
| Indenter / désindenter avec les enfants | Tab / Maj+Tab | `outline:indent`, `outline:dedent` |
| Note sous l'élément | Maj+Entrée | `outline:add-note` |
| Monter / descendre avec les enfants | Alt+↑ / Alt+↓, Ctrl+Maj+↑ / ↓ | `outline:move-item-up`, `outline:move-item-down` |
| Plier / déplier (ou flèche au survol, à gauche) | Ctrl+↑ / Ctrl+↓ | `outline:fold`, `outline:unfold`, `outline:toggle-fold` |
| Entrer dans l'élément / remonter | Ctrl+. ou Alt+→ / Échap, Ctrl+Maj+. ou Alt+← | `outline:zoom-in`, `outline:zoom-out` |
| Sélectionner l'élément, puis tout | Ctrl+A | `outline:select-item` |

La vue ne gère aucune touche elle-même : tout passe par le moteur de
raccourcis, et chaque touche se change dans Paramètres > Raccourcis. Une
commande ne prend la touche que si elle s'applique (Retour arrière : au début
d'un élément) ; sinon la touche sert à écrire.

## Édition à plusieurs

Le type est déclaré `crdt` : la vue se branche sur le texte partagé du
document (`ctx.text`). Sans texte partagé (pas de session de vault), le plan
s'affiche en lecture seule.
