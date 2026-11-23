<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- SPDX-FileCopyrightText: 2026 Jean Leloup -->
# plugin-footnotes — Notes de bas de page

Les notes de bas de page de Markdown, comme dans Obsidian et Pandoc :

```markdown
Une phrase avec une note[^1].

[^1]: Le texte de la note.
```

- L'appel `[^1]` s'affiche en petit numéro, en exposant. Au survol, il montre la note.
- Un clic sur l'appel va à la note ; un clic sur le numéro de la note revient à l'appel.
- « Insérer une note de bas de page » (menu Insérer de la barre, palette de
  commandes) pose l'appel au curseur et la définition en fin de note, avec le
  numéro suivant.

Le rendu passe par un hook `beforeParse` : il vaut aussi pour l'export et la
page publiée. Le code (``` ` ``` et blocs ```` ``` ````) n'est pas touché.
